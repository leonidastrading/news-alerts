// The detection rules, kept free of I/O so they can be tested: which headlines to watch, which
// stocks are worth watching, and when a stock's move after a headline becomes an alert.
//
// Two kinds of alert:
// - Intraday: news while the market is open. The price when the headline arrives is the starting
//   point; a move of MOVE_PCT from it, held for CONFIRM_TICKS checks, is an alert.
// - Pre-open: news from while the market was closed. The stock may already have gapped, so the first
//   minutes after the open form an opening range; a break above its high or below its low, held for
//   CONFIRM_TICKS checks, is an alert.
import type { Config } from "./config.ts";
import { nyDate } from "./time.ts";

export type NewsItem = {
  id: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  author?: string;
  symbols: string[];
  createdAt: string; // ISO
};

type Tracking = {
  symbol: string;
  news: NewsItem;
  /** When we received the headline (ms). */
  seenAt: number;
  /** Consecutive checks beyond the trigger, in the same direction. */
  hits: number;
  direction: 1 | -1 | 0;
  lastPrice?: number;
};

export type Watch = Tracking & {
  /** Price when the headline arrived: the first fresh trade we see after it. */
  baseline?: number;
};

export type GapWatch = Tracking & {
  /** How many headlines about this stock came out while the market was closed. */
  newsCount: number;
  prevClose?: number;
  open?: number;
  rangeHigh?: number;
  rangeLow?: number;
  rangeVolume?: number;
  /** Set once a price inside the opening range has been seen; only breaks after that count. */
  armed?: boolean;
};

const US_TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;

/** Every US ticker a headline is tagged with. */
export const usTickers = (news: NewsItem) => [...new Set(news.symbols.map((s) => s.toUpperCase()))].filter((s) => US_TICKER.test(s));

// Articles that don't explain a move: call transcripts, comparisons, explainers, data roundups.
const NOT_NEWS =
  /\b(transcript|earnings call|conference call|performance comparison|competitors in|in focus|stocks to watch|market (wrap|recap|update)|(unusual )?options activity|whale|short interest|technical analysis|price (prediction|forecast)|p\/e ratio|insights? into|analyzing|a look at|peeling back|deep dive|here'?s how much|if you invested|\d+ (stocks|etfs)|what to expect|earnings preview|ahead of earnings|key takeaways)\b/i;
export const isNotNews = (headline: string) => NOT_NEWS.test(headline);

/** The US tickers a headline is about, or [] for roundups tagged with too many and for non-news articles. */
export function tickersOf(news: NewsItem, cfg: Pick<Config, "maxSymbolsPerHeadline">): string[] {
  if (isNotNews(news.headline)) return [];
  const syms = usTickers(news);
  return syms.length > cfg.maxSymbolsPerHeadline ? [] : syms;
}

/** Tickers to watch for a headline that just arrived during the session, or [] to ignore it. */
export function symbolsToWatch(news: NewsItem, now: number, cfg: Pick<Config, "maxSymbolsPerHeadline">): string[] {
  // The stream replays a little history on connect; only act on fresh news.
  const age = now - Date.parse(news.createdAt);
  if (!(age < 10 * 60_000)) return [];
  return tickersOf(news, cfg);
}

/** Latest headline and headline count per ticker, for news published while the market was closed. */
export function preOpenNews(items: NewsItem[], cfg: Pick<Config, "maxSymbolsPerHeadline">): Map<string, { news: NewsItem; count: number }> {
  const out = new Map<string, { news: NewsItem; count: number }>();
  for (const n of items) {
    for (const s of tickersOf(n, cfg)) {
      const prev = out.get(s);
      if (!prev) out.set(s, { news: n, count: 1 });
      else out.set(s, { news: n.createdAt >= prev.news.createdAt ? n : prev.news, count: prev.count + 1 });
    }
  }
  return out;
}

export type Snapshot = {
  price: number;
  /** Time of the latest trade (ms). */
  tradeAt: number;
  /** Previous day's close × volume on IEX. */
  prevDollarVolume: number;
  prevClose: number | null;
  /** Shares traded today / yesterday on IEX. */
  dayVolume: number | null;
  prevVolume: number | null;
};

/** Why a stock shouldn't be watched, or null if it should. */
export function rejectReason(s: Snapshot, cfg: Pick<Config, "minPrice" | "minIexDollarVolume">): string | null {
  if (!(s.price >= cfg.minPrice)) return `price under $${cfg.minPrice}`;
  if (!(s.prevDollarVolume >= cfg.minIexDollarVolume)) return "too thinly traded";
  return null;
}

export type Verdict = "wait" | "alert" | "expire";

/** Count a check that is past the trigger in direction `dir` (0 = not past it). */
function countHit(w: Tracking, dir: 1 | -1 | 0, confirmTicks: number): Verdict {
  if (dir !== 0 && dir === w.direction) w.hits++;
  else w.hits = dir === 0 ? 0 : 1;
  w.direction = dir;
  return w.hits >= confirmTicks ? "alert" : "wait";
}

// Ignore stale prices (halts, illiquid names, outside trading hours).
const isStale = (s: Snapshot, now: number) => now - s.tradeAt > 5 * 60_000;

/** Advance an intraday watch with a new price. Mutates the watch. */
export function evaluate(w: Watch, s: Snapshot, now: number, cfg: Pick<Config, "movePct" | "confirmTicks" | "watchMinutes">): Verdict {
  if (now - w.seenAt > cfg.watchMinutes * 60_000) return "expire";
  if (isStale(s, now)) return "wait";
  if (w.baseline === undefined) {
    w.baseline = s.price;
    return "wait";
  }
  w.lastPrice = s.price;
  const move = s.price / w.baseline - 1;
  return countHit(w, Math.abs(move) >= cfg.movePct ? (move > 0 ? 1 : -1) : 0, cfg.confirmTicks);
}

/** Advance a pre-open watch once its opening range is set. Mutates the watch. */
export function evaluateBreakout(g: GapWatch, s: Snapshot, now: number, endAt: number, cfg: Pick<Config, "confirmTicks" | "breakoutBuffer">): Verdict {
  if (now > endAt) return "expire";
  if (g.rangeHigh === undefined || g.rangeLow === undefined || isStale(s, now)) return "wait";
  g.lastPrice = s.price;
  const dir = s.price > g.rangeHigh * (1 + cfg.breakoutBuffer) ? 1 : s.price < g.rangeLow * (1 - cfg.breakoutBuffer) ? -1 : 0;
  // A stock already outside its range when we first look (e.g. the monitor started late) hasn't
  // broken out in front of us: wait until it trades back inside, then count a fresh break.
  if (!g.armed) {
    if (dir === 0) g.armed = true;
    return "wait";
  }
  return countHit(g, dir, cfg.confirmTicks);
}

/** Open, high, low and volume of the opening range from its 1-minute bars. */
export function openingRange(bars: { o: number; h: number; l: number; v: number }[]) {
  if (bars.length === 0) return null;
  return {
    open: bars[0].o,
    high: Math.max(...bars.map((b) => b.h)),
    low: Math.min(...bars.map((b) => b.l)),
    volume: bars.reduce((s, b) => s + b.v, 0),
  };
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

/**
 * Safety cap against bursts (a bug, a market-wide shock): given the times of today's emailed/traded
 * alerts, whether another one now would exceed the limits.
 */
export function overAlertLimit(sentToday: number[], now: number, cfg: Pick<Config, "maxAlertsPer5Min" | "maxAlertsPerDay">): string | null {
  if (sentToday.length >= cfg.maxAlertsPerDay) return `daily limit of ${cfg.maxAlertsPerDay} alerts reached`;
  if (sentToday.filter((t) => now - t < 5 * 60_000).length >= cfg.maxAlertsPer5Min) return `limit of ${cfg.maxAlertsPer5Min} alerts per 5 minutes reached`;
  return null;
}
