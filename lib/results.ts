// How an alert turned out: the price 15 and 60 minutes after it, and the next trading day's close.
import type { Bar } from "./alpaca.ts";

import { nyDate, nyToUtc } from "./time.ts";

/**
 * Close of the first 1-minute bar at least `minutes` after `at`, if one printed within 10 minutes of
 * that. When that time falls after the 4:00 PM close (a late-session alert), the day's last bar instead.
 */
export function priceAfter(bars: Pick<Bar, "t" | "c">[], at: number, minutes: number): number | null {
  const from = at + minutes * 60_000;
  const closeAt = nyToUtc(nyDate(at), "16:00");
  if (at < closeAt && from >= closeAt) return bars.filter((b) => b.t >= at && b.t < closeAt).at(-1)?.c ?? null;
  const bar = bars.find((b) => b.t >= from && b.t < from + 10 * 60_000);
  return bar ? bar.c : null;
}

/** Close on the alert's own New York date, once that day's daily bar is in. */
export function sameDayClose(daily: Pick<Bar, "t" | "c">[], at: number): number | null {
  const day = nyDate(at);
  return daily.find((b) => nyDate(b.t) === day)?.c ?? null;
}

/** Close of the first trading day after the alert's New York date. */
export function nextDayClose(daily: Pick<Bar, "t" | "c">[], at: number): number | null {
  const day = nyDate(at);
  const bar = daily.find((b) => nyDate(b.t) > day);
  return bar ? bar.c : null;
}

/** Results are final once the next-day close is in, or after five days whatever is missing. */
export function resultsDone(r: { price60m: number | null; close0d?: number | null; close1d: number | null }, at: number, now: number): boolean {
  return (r.price60m != null && r.close0d !== null && r.close1d != null) || now - at > 5 * 86_400_000;
}
