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
  type GapWatch,
  type NewsItem,
  type Snapshot,
  type Watch,
} from "../lib/detect.ts";
import { categorize } from "../lib/category.ts";
import { nyDate, nyToUtc } from "../lib/time.ts";
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
  writeStatus,
  type AlertRow,
  type NewAlert,
} from "../lib/db.ts";
import { sendAlertEmail } from "../lib/email.ts";
import { nextDayClose, priceAfter, resultsDone } from "../lib/results.ts";

const cfg = loadConfig();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const watches = new Map<string, Watch>();

// News from while the market was closed, watched from the open.
type OpenSession = { date: string; openAt: number; rangeEnd: number; endAt: number; ranged: boolean; watches: Map<string, GapWatch> };
let session: OpenSession | null = null;
let sessionDate = "";
const rejectedUntil = new Map<string, number>();
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
  const now = Date.now();
  for (const symbol of symbolsToWatch(n, now, cfg)) {
    if (watches.has(symbol) || session?.watches.has(symbol)) continue;
    if ((rejectedUntil.get(symbol) ?? 0) > now) continue;
    if ((lastAlertAt[symbol] ?? 0) > now - cfg.cooldownMinutes * 60_000) continue;
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
  if (session && now > session.endAt) session = null;
}

async function setUpOpen(today: string, now: number) {
  const days = await calendar(nyDate(now - 10 * 86_400_000), today);
  const todayCal = days.find((d) => d.date === today);
  const prev = days.filter((d) => d.date < today).at(-1);
  if (!todayCal || !prev) return;
  const openAt = nyToUtc(today, todayCal.open);
  const endAt = openAt + cfg.openWatchMinutes * 60_000;
  if (now >= endAt - 5 * 60_000) return; // started too late in the day to use the open
  const prevCloseAt = nyToUtc(prev.date, prev.close);
  const items = await newsBetween(new Date(prevCloseAt), new Date(openAt));
  const byTicker = [...preOpenNews(items, cfg)]
    .filter(([sym]) => (lastAlertAt[sym] ?? 0) <= now - cfg.cooldownMinutes * 60_000)
    .sort((x, y) => y[1].count - x[1].count)
    .slice(0, 400);
  const gw = new Map<string, GapWatch>();
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
    if (!r || !snap || rejectReason(snap, cfg)) {
      s.watches.delete(sym);
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
      if (now - w.seenAt > cfg.watchMinutes * 60_000) watches.delete(symbol);
      continue;
    }
    if (w.baseline === undefined) {
      const reason = rejectReason(s, cfg);
      if (reason) {
        watches.delete(symbol);
        rejectedUntil.set(symbol, now + 6 * 3_600_000);
        stats.rejected++;
        continue;
      }
    }
    const verdict = evaluate(w, s, now, cfg);
    if (verdict === "expire") watches.delete(symbol);
    else if (verdict === "alert") {
      watches.delete(symbol);
      lastAlertAt[symbol] = now;
      await fireIntraday(w, s, now).catch((e) => noteError(`alert ${symbol}`, e));
    }
  }
  if (gapping) {
    for (const [symbol, g] of gapping.watches) {
      const s = snaps[symbol];
      if (!s) continue;
      const verdict = evaluateBreakout(g, s, now, gapping.endAt, cfg);
      if (verdict === "expire") gapping.watches.delete(symbol);
      else if (verdict === "alert") {
        gapping.watches.delete(symbol);
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
  every(300, "follow-up", followUp);
  every(3600, "status", saveStatus);
}

process.on("unhandledRejection", (e) => noteError("unhandled", e));
main().catch((e) => {
  log("FATAL", e);
  process.exit(1);
});
