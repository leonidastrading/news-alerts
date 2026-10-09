// The always-on listener (runs on Railway): Alpaca's live news stream in, price checks every few
// seconds on the stocks in the news, an email and a paper trade when one moves, and follow-up on
// fills and results. News from while the market is closed is picked up at the open and traded on a
// break of the opening range. Run with: npm run worker
import { loadConfig } from "../lib/config.ts";
import {
  asset,
  bars,
  barsMulti,
  calendar,
  clock,
  closePosition,
  credentials,
  getOrder,
  hasPosition,
  movers,
  newsBetween,
  newsSince,
  NEWS_STREAM,
  placeMarketOrder,
  snapshots,
  toNewsItem,
  type Clock,
} from "../lib/alpaca.ts";
import {
  evaluate,
  evaluateBreakout,
  openingRange,
  preOpenNews,
  rejectReason,
  shouldExit,
  symbolsToWatch,
  usTickers,
  isNotNews,
  type GapWatch,
  type NewsItem,
  type Snapshot,
  type Watch,
} from "../lib/detect.ts";
import { categorize } from "../lib/category.ts";
import { classifyOrigin } from "../lib/origin.ts";
import { nyDate, nyToUtc } from "../lib/time.ts";
import { missReason, type DayLog, type WatchOutcome } from "../lib/misses.ts";
import {
  insertAlert,
  lastAlertTimes,
  migrate,
  pendingAlerts,
  setEntryFill,
  setExitFill,
  setResults,
  setTradeClosed,
  setTradeOpened,
  setTradeStatus,
  upsertMiss,
  alertedOn,
  writeStatus,
  type AlertRow,
  type NewAlert,
} from "../lib/db.ts";
import { sendAlertEmail } from "../lib/email.ts";
import { nextDayClose, priceAfter, resultsDone } from "../lib/results.ts";

const cfg = loadConfig();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

type TrackedWatch = Watch & { maxMove?: number; preMove?: number | null };
const watches = new Map<string, TrackedWatch>();

// Every headline and watch for each stock this session, to explain missed moves (see scanMisses).
// Reset at each open and refilled with the news since the previous close.
let dayLog = new Map<string, DayLog>();
const logFor = (symbol: string) => {
  let l = dayLog.get(symbol);
  if (!l) dayLog.set(symbol, (l = { headlines: [], watches: [] }));
  return l;
};
function logHeadline(n: NewsItem) {
  const tickers = usTickers(n);
  const roundup = tickers.length > cfg.maxSymbolsPerHeadline || isNotNews(n.headline);
  const origin = classifyOrigin(n);
  for (const t of tickers) logFor(t).headlines.push({ at: Date.parse(n.createdAt), headline: n.headline, url: n.url, roundup, origin });
}
function logWatch(symbol: string, w: Omit<WatchOutcome, "endedAt"> & { endedAt?: number }) {
  logFor(symbol).watches.push({ ...w, endedAt: w.endedAt ?? Date.now() });
}

// News from while the market was closed, watched from the open.
type TrackedGap = GapWatch & { maxMove?: number };
type OpenSession = { date: string; openAt: number; rangeEnd: number; endAt: number; ranged: boolean; watches: Map<string, TrackedGap> };
let session: OpenSession | null = null;
let sessionDate = "";
let prevCloseAt = 0;
const rejectedUntil = new Map<string, { until: number; reason: string }>();
const seenNews = new Set<number>();
let lastAlertAt: Record<string, number> = {};
let market: Clock | null = null;
let lastNewsAt = new Date();
let pendingCount = 0;

const stats = {
  startedAt: new Date().toISOString(),
  stream: "connecting",
  newsSeen: 0,
  watched: 0,
  rejected: 0,
  alerts: 0,
  preOpenWatched: 0,
  misses: 0,
  lastNewsAt: null as string | null,
  lastError: null as string | null,
};

function noteError(where: string, e: unknown) {
  stats.lastError = `${new Date().toISOString()} ${where}: ${e instanceof Error ? e.message : String(e)}`;
  log("ERROR", where, e);
}

// ---------- News in ----------

function onNews(n: NewsItem) {
  if (seenNews.has(n.id)) return;
  seenNews.add(n.id);
  if (seenNews.size > 5000) seenNews.delete(seenNews.values().next().value!);
  stats.newsSeen++;
  stats.lastNewsAt = n.createdAt;
  if (Date.parse(n.createdAt) > lastNewsAt.getTime()) lastNewsAt = new Date(n.createdAt);
  // While the market is closed, news is collected at the open instead (see setUpOpen).
  if (!market?.is_open) return;
  logHeadline(n);
  const now = Date.now();
  for (const symbol of symbolsToWatch(n, now, cfg)) {
    if (watches.has(symbol) || session?.watches.has(symbol)) continue;
    const rejected = rejectedUntil.get(symbol);
    if (rejected && rejected.until > now) {
      logWatch(symbol, { kind: "intraday", startedAt: now, outcome: `filtered: ${rejected.reason}`, maxMove: null, preMove: null });
      continue;
    }
    if ((lastAlertAt[symbol] ?? 0) > now - cfg.cooldownMinutes * 60_000) {
      logWatch(symbol, { kind: "intraday", startedAt: now, outcome: "cooldown", maxMove: null, preMove: null });
      continue;
    }
    watches.set(symbol, { symbol, news: n, seenAt: now, hits: 0, direction: 0 });
    stats.watched++;
  }
}

function connectNews(attempt = 0) {
  const { key, secret } = credentials();
  const ws = new WebSocket(NEWS_STREAM);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
    let msgs: Record<string, unknown>[];
    try {
      msgs = JSON.parse(text);
    } catch {
      return;
    }
    for (const m of msgs) {
      if (m.T === "success" && m.msg === "connected") ws.send(JSON.stringify({ action: "auth", key, secret }));
      else if (m.T === "success" && m.msg === "authenticated") ws.send(JSON.stringify({ action: "subscribe", news: ["*"] }));
      else if (m.T === "subscription") {
        stats.stream = "live";
        attempt = 0;
        log("news stream live");
        void saveStatus();
      } else if (m.T === "n") onNews(toNewsItem(m as Parameters<typeof toNewsItem>[0]));
      else if (m.T === "error") noteError("news stream", `${m.code} ${m.msg}`);
    }
  };
  ws.onclose = () => {
    const wasLive = stats.stream === "live";
    stats.stream = "reconnecting";
    if (wasLive) void saveStatus();
    const delay = Math.min(60_000, 2_000 * 2 ** attempt);
    log(`news stream closed; reconnecting in ${delay / 1000}s`);
    setTimeout(() => connectNews(attempt + 1), delay);
  };
  ws.onerror = () => {}; // onclose follows and reconnects
}

// While the stream is down, poll the news REST endpoint instead.
async function pollNewsFallback() {
  if (stats.stream === "live") return;
  const items = await newsSince(new Date(Math.max(lastNewsAt.getTime(), Date.now() - 10 * 60_000)));
  items.forEach(onNews);
}

// ---------- The open: news from while the market was closed ----------

async function checkSession() {
  if (!market?.is_open) return;
  const now = Date.now();
  const today = nyDate(now);
  if (sessionDate !== today) {
    sessionDate = today;
    session = null;
    await setUpOpen(today, now);
  }
  if (session && !session.ranged && now >= session.rangeEnd) await setRanges(session);
  if (session && now > session.endAt) {
    for (const g of session.watches.values()) endGapWatch(g, "expired");
    session = null;
  }
}

function endGapWatch(g: TrackedGap, outcome: string) {
  const gap = g.prevClose && g.open ? g.open / g.prevClose - 1 : null;
  logWatch(g.symbol, { kind: "preopen", startedAt: g.seenAt, outcome, maxMove: g.maxMove ?? null, preMove: gap });
}

async function setUpOpen(today: string, now: number) {
  dayLog = new Map();
  missRecorded.clear();
  const days = await calendar(nyDate(now - 10 * 86_400_000), today);
  const todayCal = days.find((d) => d.date === today);
  const prev = days.filter((d) => d.date < today).at(-1);
  if (!todayCal || !prev) return;
  const openAt = nyToUtc(today, todayCal.open);
  const endAt = openAt + cfg.openWatchMinutes * 60_000;
  prevCloseAt = nyToUtc(prev.date, prev.close);
  const items = await newsBetween(new Date(prevCloseAt), new Date(openAt));
  items.forEach(logHeadline);
  // Started well after the opening range ended (e.g. a redeploy mid-morning): the range is stale, skip today.
  if (now > openAt + (cfg.openRangeMinutes + 5) * 60_000) {
    log("open: started too late to use today's opening range; pre-open news is only logged");
    return;
  }
  const byTicker = [...preOpenNews(items, cfg)]
    .filter(([sym]) => (lastAlertAt[sym] ?? 0) <= now - cfg.cooldownMinutes * 60_000)
    .sort((x, y) => y[1].count - x[1].count)
    .slice(0, 400);
  const gw = new Map<string, TrackedGap>();
  for (const [symbol, { news, count }] of byTicker) {
    gw.set(symbol, { symbol, news, newsCount: count, seenAt: now, hits: 0, direction: 0 });
  }
  session = { date: today, openAt, rangeEnd: openAt + cfg.openRangeMinutes * 60_000, endAt, ranged: false, watches: gw };
  stats.preOpenWatched += gw.size;
  log(`open: ${items.length} headlines since the last close, watching ${gw.size} stocks for an opening-range break`);
}

async function setRanges(s: OpenSession) {
  const syms = [...s.watches.keys()];
  s.ranged = true;
  if (syms.length === 0) return;
  const [rangeBars, snaps] = await Promise.all([
    barsMulti(syms, "1Min", new Date(s.openAt), new Date(s.rangeEnd - 1)),
    snapshots(syms),
  ]);
  for (const [sym, g] of s.watches) {
    const r = openingRange(rangeBars[sym] ?? []);
    const snap = snaps[sym];
    const reason = !r || !snap ? "no opening-range data" : rejectReason(snap, cfg);
    if (reason || !r) {
      s.watches.delete(sym);
      logWatch(sym, { kind: "preopen", startedAt: g.seenAt, outcome: r && snap ? `filtered: ${reason}` : "no opening-range data", maxMove: null, preMove: null });
      continue;
    }
    Object.assign(g, { open: r.open, rangeHigh: r.high, rangeLow: r.low, rangeVolume: r.volume, prevClose: snap.prevClose ?? undefined });
  }
  log(`opening ranges set for ${s.watches.size} stocks`);
}

// ---------- Price checks ----------

async function checkPrices() {
  const gapping = session?.ranged ? session : null;
  const symbols = [...new Set([...watches.keys(), ...(gapping ? gapping.watches.keys() : [])])];
  if (symbols.length === 0) return;
  const snaps = await snapshots(symbols);
  const now = Date.now();
  for (const [symbol, w] of watches) {
    const s = snaps[symbol];
    if (!s) {
      if (now - w.seenAt > cfg.watchMinutes * 60_000) {
        watches.delete(symbol);
        logWatch(symbol, { kind: "intraday", startedAt: w.seenAt, outcome: "expired", maxMove: null, preMove: null });
      }
      continue;
    }
    if (w.baseline === undefined) {
      const reason = rejectReason(s, cfg);
      if (reason) {
        watches.delete(symbol);
        rejectedUntil.set(symbol, { until: now + 6 * 3_600_000, reason });
        logWatch(symbol, { kind: "intraday", startedAt: w.seenAt, outcome: `filtered: ${reason}`, maxMove: null, preMove: null });
        stats.rejected++;
        continue;
      }
    }
    const hadBaseline = w.baseline !== undefined;
    const verdict = evaluate(w, s, now, cfg);
    if (!hadBaseline && w.baseline !== undefined) w.preMove = s.prevClose ? w.baseline / s.prevClose - 1 : null;
    if (w.baseline !== undefined && w.lastPrice !== undefined) {
      const m = w.lastPrice / w.baseline - 1;
      if (w.maxMove === undefined || Math.abs(m) > Math.abs(w.maxMove)) w.maxMove = m;
    }
    const ended = { kind: "intraday" as const, startedAt: w.seenAt, maxMove: w.maxMove ?? null, preMove: w.preMove ?? null };
    if (verdict === "expire") {
      watches.delete(symbol);
      logWatch(symbol, { ...ended, outcome: "expired" });
    } else if (verdict === "alert") {
      watches.delete(symbol);
      logWatch(symbol, { ...ended, outcome: "alert" });
      lastAlertAt[symbol] = now;
      await fireIntraday(w, s, now).catch((e) => noteError(`alert ${symbol}`, e));
    }
  }
  if (gapping) {
    for (const [symbol, g] of gapping.watches) {
      const s = snaps[symbol];
      if (!s) continue;
      const verdict = evaluateBreakout(g, s, now, gapping.endAt, cfg);
      if (g.open && g.lastPrice !== undefined) {
        const m = g.lastPrice / g.open - 1;
        if (g.maxMove === undefined || Math.abs(m) > Math.abs(g.maxMove)) g.maxMove = m;
      }
      if (verdict === "expire") {
        gapping.watches.delete(symbol);
        endGapWatch(g, "expired");
      } else if (verdict === "alert") {
        gapping.watches.delete(symbol);
        endGapWatch(g, "alert");
        lastAlertAt[symbol] = now;
        await fireBreakout(g, s, now).catch((e) => noteError(`alert ${symbol}`, e));
      }
    }
  }
}

async function fireIntraday(w: Watch, s: Snapshot, now: number) {
  const since = await bars(w.symbol, "1Min", new Date(w.news.createdAt), new Date(now)).catch(() => []);
  await fire({
    kind: "intraday",
    symbol: w.symbol,
    direction: w.direction,
    newsId: w.news.id,
    headline: w.news.headline,
    summary: w.news.summary,
    category: categorize(w.news.headline, w.news.summary),
    origin: classifyOrigin(w.news),
    url: w.news.url,
    source: w.news.source,
    newsAt: w.news.createdAt,
    newsCount: 1,
    seenAt: new Date(w.seenAt),
    alertedAt: new Date(now),
    baseline: w.baseline!,
    price: s.price,
    movePct: s.price / w.baseline! - 1,
    prevClose: s.prevClose,
    openPrice: null,
    gapPct: null,
    rangeHigh: null,
    rangeLow: null,
    rangeVolume: null,
    volumeSince: since.length ? since.reduce((t, b) => t + b.v, 0) : null,
    dayVolume: s.dayVolume,
    prevDayVolume: s.prevVolume,
  });
}

async function fireBreakout(g: GapWatch, s: Snapshot, now: number) {
  const open = g.open!;
  await fire({
    kind: "preopen",
    symbol: g.symbol,
    direction: g.direction,
    newsId: g.news.id,
    headline: g.news.headline,
    summary: g.news.summary,
    category: categorize(g.news.headline, g.news.summary),
    origin: classifyOrigin(g.news),
    url: g.news.url,
    source: g.news.source,
    newsAt: g.news.createdAt,
    newsCount: g.newsCount,
    seenAt: new Date(g.seenAt),
    alertedAt: new Date(now),
    baseline: g.direction > 0 ? g.rangeHigh! : g.rangeLow!,
    price: s.price,
    movePct: s.price / open - 1,
    prevClose: g.prevClose ?? null,
    openPrice: open,
    gapPct: g.prevClose ? open / g.prevClose - 1 : null,
    rangeHigh: g.rangeHigh!,
    rangeLow: g.rangeLow!,
    rangeVolume: g.rangeVolume ?? null,
    volumeSince: s.dayVolume,
    dayVolume: s.dayVolume,
    prevDayVolume: s.prevVolume,
  });
}

async function fire(a: NewAlert) {
  const id = await insertAlert(a);
  stats.alerts++;
  pendingCount++;
  log(`ALERT ${a.kind} ${a.symbol} ${a.direction > 0 ? "up" : "down"} after "${a.headline}"`);
  const trade = cfg.paperTrading ? await openTrade(id, a.symbol, a.direction, a.price) : "off";
  await sendAlertEmail({ ...a, minutesAfterNews: (a.alertedAt.getTime() - Date.parse(a.newsAt)) / 60_000, trade }).catch((e) =>
    noteError(`email ${a.symbol}`, e),
  );
}

// ---------- Missed moves ----------

const US_TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;
const missRecorded = new Map<string, number>(); // symbol -> largest |day change| recorded today
let moversAvailable = true;

async function scanMisses() {
  if (!market?.is_open || !moversAvailable) return;
  const now = Date.now();
  const today = nyDate(now);
  if (sessionDate !== today || !prevCloseAt) return;
  let list;
  try {
    list = await movers(50);
  } catch (e) {
    if (/HTTP (401|403|404)/.test(String(e))) {
      moversAvailable = false;
      noteError("movers (missed-move check turned off: not available on this Alpaca plan)", e);
      return;
    }
    throw e;
  }
  const big = list.filter((m) => US_TICKER.test(m.symbol) && Math.abs(m.percent_change) / 100 >= cfg.missMovePct && m.price >= cfg.minPrice);
  if (big.length === 0) return;
  const [alerted, snaps] = await Promise.all([alertedOn(today), snapshots(big.map((m) => m.symbol))]);
  for (const m of big) {
    const change = m.percent_change / 100;
    const snap = snaps[m.symbol];
    if (alerted.has(m.symbol) || watches.has(m.symbol) || session?.watches.has(m.symbol)) continue;
    if (!snap || snap.prevDollarVolume < cfg.minIexDollarVolume) continue; // too thin to have traded anyway
    const prevAbs = missRecorded.get(m.symbol);
    if (prevAbs !== undefined && Math.abs(change) < prevAbs + 0.01) continue;
    let log = dayLog.get(m.symbol);
    if (!log) {
      // Nothing in memory (e.g. the monitor restarted): ask the news API directly.
      const items = await newsBetween(new Date(prevCloseAt), new Date(now), 2, [m.symbol]);
      items.forEach(logHeadline);
      log = dayLog.get(m.symbol);
    }
    const reason = missReason(log, Date.parse(stats.startedAt), cfg.movePct);
    const h = log?.headlines.filter((x) => !x.roundup).at(-1) ?? log?.headlines.at(-1);
    await upsertMiss({
      day: today,
      symbol: m.symbol,
      dayChangePct: change,
      price: m.price,
      prevClose: snap.prevClose,
      dayVolume: snap.dayVolume,
      reasonCode: reason.code,
      reasonText: reason.text,
      headline: h?.headline ?? null,
      url: h?.url ?? null,
      newsAt: h ? new Date(h.at).toISOString() : null,
      origin: h?.origin ?? null,
    });
    missRecorded.set(m.symbol, Math.abs(change));
    stats.misses++;
  }
}

// ---------- Paper trades ----------

const openTrades = new Map<number, { symbol: string; openedAt: number }>();

async function openTrade(id: number, symbol: string, direction: number, price: number): Promise<string> {
  const skip = async (reason: string) => {
    await setTradeOpened(id, `skipped: ${reason}`, null, null);
    return `skipped (${reason})`;
  };
  try {
    if (!market?.is_open) return await skip("market closed");
    if (Date.parse(market.next_close) - Date.now() < 15 * 60_000) return await skip("too close to the close");
    const qty = Math.floor(cfg.tradeNotional / price);
    if (qty < 1) return await skip("price above trade size");
    if (await hasPosition(symbol)) return await skip("already holding");
    if (direction < 0) {
      const a = await asset(symbol);
      if (!a.shortable || !a.easy_to_borrow) return await skip("not shortable");
    }
    const side = direction > 0 ? "buy" : "sell";
    const order = await placeMarketOrder(symbol, qty, side);
    await setTradeOpened(id, "open", qty, order.id, order.submitted_at ?? new Date().toISOString());
    openTrades.set(id, { symbol, openedAt: Date.now() });
    const exit = cfg.holdMinutes > 0 ? `after ${cfg.holdMinutes} min` : "just before the close";
    return `${direction > 0 ? "bought" : "shorted"} ${qty} shares at market, closing ${exit}`;
  } catch (e) {
    noteError(`trade ${symbol}`, e);
    await setTradeOpened(id, "error", null, null).catch(() => {});
    return "error placing order";
  }
}

async function manageTrades() {
  if (openTrades.size === 0) return;
  if (!market?.is_open) return;
  const now = Date.now();
  const closeAt = Date.parse(market.next_close);
  for (const [id, t] of openTrades) {
    if (!shouldExit(t.openedAt, now, closeAt, cfg.holdMinutes)) continue;
    try {
      const order = await closePosition(t.symbol);
      await setTradeClosed(id, order.id, new Date());
    } catch (e) {
      // No position: the entry never filled or was already closed by hand.
      if (!String(e).includes("HTTP 404")) {
        noteError(`close ${t.symbol}`, e);
        continue;
      }
      await setTradeClosed(id, null, new Date());
    }
    openTrades.delete(id);
  }
}

// ---------- Follow-up: fills and results ----------

const DEAD = new Set(["canceled", "rejected", "expired"]);

async function followUp() {
  if (pendingCount === 0 && openTrades.size === 0) return;
  const rows: AlertRow[] = await pendingAlerts();
  pendingCount = rows.length;
  const now = Date.now();
  for (const a of rows) {
    try {
      if (a.entry_order_id && a.entry_price == null && !a.trade_status?.startsWith("error")) {
        const o = await getOrder(a.entry_order_id);
        if (o.filled_avg_price) {
          a.entry_price = Number(o.filled_avg_price);
          await setEntryFill(a.id, a.entry_price, o.filled_at);
        } else if (DEAD.has(o.status)) {
          await setTradeStatus(a.id, `error: entry order ${o.status}`);
          openTrades.delete(a.id);
        }
      }
      if (a.exit_order_id && a.exit_price == null && a.entry_price != null && a.qty && !a.trade_status?.startsWith("error")) {
        const o = await getOrder(a.exit_order_id);
        if (o.filled_avg_price) {
          const p = Number(o.filled_avg_price);
          await setExitFill(a.id, p, a.direction * (p - a.entry_price) * a.qty, o.filled_at);
        } else if (DEAD.has(o.status)) {
          await setTradeStatus(a.id, `error: exit order ${o.status}`);
        }
      }
      const at = Date.parse(a.alerted_at);
      if (!a.results_done && now - at >= 15 * 60_000) {
        const min = await bars(a.symbol, "1Min", new Date(at), new Date(Math.min(now, at + 75 * 60_000)));
        const daily = now - at > 12 * 3_600_000 ? await bars(a.symbol, "1Day", new Date(at), new Date(now)) : [];
        const r = {
          price15m: a.price_15m ?? priceAfter(min, at, 15),
          price60m: a.price_60m ?? priceAfter(min, at, 60),
          close1d: a.close_1d ?? nextDayClose(daily, at),
        };
        await setResults(a.id, { ...r, done: resultsDone(r, at, now) });
      }
    } catch (e) {
      noteError(`follow-up ${a.symbol} #${a.id}`, e);
    }
  }
}

// ---------- Main ----------

async function saveStatus() {
  try {
    await writeStatus({
      ...stats,
      watching: watches.size,
      watchingFromOpen: session?.watches.size ?? 0,
      openTrades: openTrades.size,
      market: market?.is_open ?? null,
    });
  } catch (e) {
    noteError("status", e);
  }
}

function every(seconds: number, name: string, fn: () => Promise<void>) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      noteError(name, e);
    } finally {
      running = false;
    }
  };
  setInterval(run, seconds * 1000);
  void run();
}

async function main() {
  credentials();
  await migrate();
  market = await clock();
  lastAlertAt = await lastAlertTimes();
  for (const a of await pendingAlerts()) {
    pendingCount++;
    if (a.trade_status === "open") openTrades.set(a.id, { symbol: a.symbol, openedAt: Date.parse(a.alerted_at) });
  }
  log(`started: move ${cfg.movePct * 100}%, watch ${cfg.watchMinutes} min, paper trading ${cfg.paperTrading ? "on" : "off"}`);
  connectNews();
  every(cfg.pollSeconds, "prices", async () => {
    await checkSession();
    await checkPrices();
  });
  every(15, "news fallback", pollNewsFallback);
  every(60, "clock", async () => {
    market = await clock();
  });
  every(30, "trades", manageTrades);
  every(300, "missed moves", scanMisses);
  every(300, "follow-up", followUp);
  every(3600, "status", saveStatus);
}

process.on("unhandledRejection", (e) => noteError("unhandled", e));
main().catch((e) => {
  log("FATAL", e);
  process.exit(1);
});
