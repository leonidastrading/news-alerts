// Alpaca: market data (IEX feed, free plan) and the PAPER trading API. The trading base URL is
// fixed to paper-api so this service can never place a real-money order.
import type { NewsItem, Snapshot } from "./detect.ts";

const DATA = "https://data.alpaca.markets";
const PAPER = "https://paper-api.alpaca.markets";
export const NEWS_STREAM = "wss://stream.data.alpaca.markets/v1beta1/news";

export function credentials() {
  const key = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("ALPACA_KEY_ID and ALPACA_SECRET_KEY must be set");
  return { key, secret };
}

async function call<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const { key, secret } = credentials();
  const res = await fetch(base + path, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Alpaca ${init.method ?? "GET"} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

// ---------- News ----------

type RawNews = {
  id: number;
  headline: string;
  author?: string;
  summary?: string;
  url?: string;
  source?: string;
  symbols?: string[];
  created_at: string;
};

export const toNewsItem = (n: RawNews): NewsItem => ({
  id: n.id,
  headline: n.headline,
  summary: n.summary ?? "",
  url: n.url ?? "",
  source: n.source ?? "",
  author: n.author ?? "",
  symbols: n.symbols ?? [],
  createdAt: n.created_at,
});

/** News published after `start`, oldest first (REST fallback for the stream). */
export async function newsSince(start: Date): Promise<NewsItem[]> {
  const q = new URLSearchParams({ start: start.toISOString(), sort: "asc", limit: "50", include_content: "false" });
  const r = await call<{ news: RawNews[] }>(DATA, `/v1beta1/news?${q}`);
  return (r.news ?? []).map(toNewsItem);
}

/**
 * News published between `start` and `end`, oldest first. Fetched newest first, so if there's more
 * than `maxPages` × 50 items (a long weekend) it's the oldest that get left out, not the latest.
 */
export async function newsBetween(start: Date, end: Date, maxPages = 40, symbols?: string[]): Promise<NewsItem[]> {
  const out: NewsItem[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), sort: "desc", limit: "50", include_content: "false" });
    if (token) q.set("page_token", token);
    if (symbols?.length) q.set("symbols", symbols.join(","));
    const r = await call<{ news: RawNews[]; next_page_token?: string | null }>(DATA, `/v1beta1/news?${q}`);
    out.push(...(r.news ?? []).map(toNewsItem));
    token = r.next_page_token ?? undefined;
    if (!token) break;
  }
  return out.reverse();
}

// ---------- Prices ----------

type RawBar = { t: string; o: number; h: number; l: number; c: number; v: number };
type RawSnapshot = {
  latestTrade?: { t: string; p: number };
  prevDailyBar?: RawBar;
  dailyBar?: RawBar;
};

export async function snapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    const r = await call<Record<string, RawSnapshot>>(DATA, `/v2/stocks/snapshots?symbols=${chunk.join(",")}&feed=iex`);
    for (const [sym, s] of Object.entries(r ?? {})) {
      if (!s?.latestTrade) continue;
      const prev = s.prevDailyBar;
      out[sym] = {
        price: s.latestTrade.p,
        tradeAt: Date.parse(s.latestTrade.t),
        prevDollarVolume: prev ? prev.c * prev.v : 0,
        prevClose: prev?.c ?? null,
        dayVolume: s.dailyBar?.v ?? null,
        prevVolume: prev?.v ?? null,
      };
    }
  }
  return out;
}

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

/** 1-minute or daily bars for several symbols, oldest first. */
export async function barsMulti(symbols: string[], timeframe: "1Min" | "1Day", start: Date, end: Date): Promise<Record<string, Bar[]>> {
  const out: Record<string, Bar[]> = {};
  for (let i = 0; i < symbols.length; i += 200) {
    let token: string | undefined;
    do {
      const q = new URLSearchParams({
        symbols: symbols.slice(i, i + 200).join(","),
        timeframe,
        start: start.toISOString(),
        end: end.toISOString(),
        feed: "iex",
        limit: "10000",
        adjustment: "raw",
      });
      if (token) q.set("page_token", token);
      const r = await call<{ bars: Record<string, RawBar[]>; next_page_token?: string | null }>(DATA, `/v2/stocks/bars?${q}`);
      for (const [sym, list] of Object.entries(r.bars ?? {})) {
        (out[sym] ??= []).push(...list.map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      }
      token = r.next_page_token ?? undefined;
    } while (token);
  }
  return out;
}

export async function bars(symbol: string, timeframe: "1Min" | "1Day", start: Date, end: Date): Promise<Bar[]> {
  return (await barsMulti([symbol], timeframe, start, end))[symbol] ?? [];
}

/** The day's biggest gainers and losers (percent_change is in percent). */
export type Mover = { symbol: string; percent_change: number; change: number; price: number };
export async function movers(top = 50): Promise<Mover[]> {
  const r = await call<{ gainers?: Mover[]; losers?: Mover[] }>(DATA, `/v1beta1/screener/stocks/movers?top=${top}`);
  return [...(r.gainers ?? []), ...(r.losers ?? [])];
}

/** The most actively traded stocks today by share volume. */
export async function mostActives(top = 100): Promise<string[]> {
  const r = await call<{ most_actives?: { symbol: string }[] }>(DATA, `/v1beta1/screener/stocks/most-actives?by=volume&top=${top}`);
  return (r.most_actives ?? []).map((m) => m.symbol);
}

// ---------- Paper trading ----------

export type Clock = { is_open: boolean; next_open: string; next_close: string; timestamp: string };
export const clock = () => call<Clock>(PAPER, "/v2/clock");

/** Trading days between two New York dates (YYYY-MM-DD), with open and close as "HH:MM" New York time. */
export type CalendarDay = { date: string; open: string; close: string };
export const calendar = (start: string, end: string) => call<CalendarDay[]>(PAPER, `/v2/calendar?start=${start}&end=${end}`);

export type Asset = { tradable: boolean; shortable: boolean; easy_to_borrow: boolean };
export const asset = (symbol: string) => call<Asset>(PAPER, `/v2/assets/${encodeURIComponent(symbol)}`);

export type Order = {
  id: string;
  status: string;
  submitted_at: string | null;
  filled_avg_price: string | null;
  filled_qty: string;
  filled_at: string | null;
};

export const placeMarketOrder = (symbol: string, qty: number, side: "buy" | "sell") =>
  call<Order>(PAPER, "/v2/orders", {
    method: "POST",
    body: JSON.stringify({ symbol, qty: String(qty), side, type: "market", time_in_force: "day" }),
  });

export const getOrder = (id: string) => call<Order>(PAPER, `/v2/orders/${id}`);

/** Close the whole position in a symbol; returns the closing order. */
export const closePosition = (symbol: string) =>
  call<Order>(PAPER, `/v2/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });

export async function hasPosition(symbol: string): Promise<boolean> {
  try {
    await call(PAPER, `/v2/positions/${encodeURIComponent(symbol)}`);
    return true;
  } catch (e) {
    if (String(e).includes("HTTP 404")) return false;
    throw e;
  }
}
