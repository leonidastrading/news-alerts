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
  symbols: n.symbols ?? [],
  createdAt: n.created_at,
});

/** News published after `start`, oldest first (REST fallback for the stream). */
export async function newsSince(start: Date): Promise<NewsItem[]> {
  const q = new URLSearchParams({ start: start.toISOString(), sort: "asc", limit: "50", include_content: "false" });
  const r = await call<{ news: RawNews[] }>(DATA, `/v1beta1/news?${q}`);
  return (r.news ?? []).map(toNewsItem);
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
      };
    }
  }
  return out;
}

export type Bar = { t: number; c: number };

/** 1-minute or daily bars for one symbol, oldest first. */
export async function bars(symbol: string, timeframe: "1Min" | "1Day", start: Date, end: Date): Promise<Bar[]> {
  const q = new URLSearchParams({
    symbols: symbol,
    timeframe,
    start: start.toISOString(),
    end: end.toISOString(),
    feed: "iex",
    limit: "1000",
    adjustment: "raw",
  });
  const r = await call<{ bars: Record<string, RawBar[]> }>(DATA, `/v2/stocks/bars?${q}`);
  return (r.bars?.[symbol] ?? []).map((b) => ({ t: Date.parse(b.t), c: b.c }));
}

// ---------- Paper trading ----------

export type Clock = { is_open: boolean; next_open: string; next_close: string; timestamp: string };
export const clock = () => call<Clock>(PAPER, "/v2/clock");

export type Asset = { tradable: boolean; shortable: boolean; easy_to_borrow: boolean };
export const asset = (symbol: string) => call<Asset>(PAPER, `/v2/assets/${encodeURIComponent(symbol)}`);

export type Order = { id: string; status: string; filled_avg_price: string | null; filled_qty: string; filled_at: string | null };

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
