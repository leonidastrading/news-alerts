// The detection rules, kept free of I/O so they can be tested: which headlines to watch, which
// stocks are worth watching, and when a stock's move after a headline becomes an alert.
import type { Config } from "./config.ts";
import { nyDate } from "./results.ts";

export type NewsItem = {
  id: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  symbols: string[];
  createdAt: string; // ISO
};

export type Watch = {
  symbol: string;
  news: NewsItem;
  /** When we received the headline (ms). */
  seenAt: number;
  /** Price when the headline arrived: the first fresh trade we see after it. */
  baseline?: number;
  /** Consecutive checks beyond the threshold, signed by direction. */
  hits: number;
  direction: 1 | -1 | 0;
  lastPrice?: number;
};

const US_TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;

/** Tickers to watch for a headline, or [] to ignore it. */
export function symbolsToWatch(news: NewsItem, now: number, cfg: Pick<Config, "maxSymbolsPerHeadline">): string[] {
  const syms = [...new Set(news.symbols.map((s) => s.toUpperCase()))].filter((s) => US_TICKER.test(s));
  if (syms.length === 0 || syms.length > cfg.maxSymbolsPerHeadline) return [];
  // The stream replays a little history on connect; only act on fresh news.
  const age = now - Date.parse(news.createdAt);
  if (!(age < 10 * 60_000)) return [];
  return syms;
}

export type Snapshot = {
  price: number;
  /** Time of the latest trade (ms). */
  tradeAt: number;
  /** Previous day's close × volume on IEX. */
  prevDollarVolume: number;
};

/** Why a stock shouldn't be watched, or null if it should. */
export function rejectReason(s: Snapshot, cfg: Pick<Config, "minPrice" | "minIexDollarVolume">): string | null {
  if (!(s.price >= cfg.minPrice)) return `price under $${cfg.minPrice}`;
  if (!(s.prevDollarVolume >= cfg.minIexDollarVolume)) return "too thinly traded";
  return null;
}

export type Verdict = "wait" | "alert" | "expire";

/** Advance a watch with a new price. Mutates the watch. */
export function evaluate(w: Watch, s: Snapshot, now: number, cfg: Pick<Config, "movePct" | "confirmTicks" | "watchMinutes">): Verdict {
  if (now - w.seenAt > cfg.watchMinutes * 60_000) return "expire";
  // Ignore stale prices (halts, illiquid names, outside trading hours).
  if (now - s.tradeAt > 5 * 60_000) return "wait";
  if (w.baseline === undefined) {
    w.baseline = s.price;
    return "wait";
  }
  w.lastPrice = s.price;
  const move = s.price / w.baseline - 1;
  const dir = Math.abs(move) >= cfg.movePct ? (move > 0 ? 1 : -1) : 0;
  if (dir !== 0 && dir === w.direction) w.hits++;
  else w.hits = dir === 0 ? 0 : 1;
  w.direction = dir;
  return w.hits >= cfg.confirmTicks ? "alert" : "wait";
}

/** Return in the direction of the alert: positive means riding the move would have made money. */
export function rideReturn(direction: number, from: number | null, to: number | null): number | null {
  if (from == null || to == null || !(from > 0)) return null;
  return direction * (to / from - 1);
}

/**
 * Whether to close a paper trade now (call only while the market is open): 5 minutes before the
 * close, after `holdMinutes` if set, or straight away if it was opened on an earlier day and missed
 * its close.
 */
export function shouldExit(openedAt: number, now: number, closeAt: number, holdMinutes: number): boolean {
  if (closeAt - now < 5 * 60_000) return true;
  if (nyDate(openedAt) !== nyDate(now)) return true;
  return holdMinutes > 0 && now - openedAt >= holdMinutes * 60_000;
}
