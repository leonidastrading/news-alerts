// Why a big mover didn't get an alert, from the day's log of headlines and watches for that stock.

export type HeadlineSeen = { at: number; headline: string; url: string; roundup: boolean; origin: string };

export type WatchOutcome = {
  kind: "intraday" | "preopen";
  startedAt: number;
  endedAt: number;
  /** "alert" | "expired" | "cooldown" | "filtered: <reason>" | "no opening-range data" */
  outcome: string;
  /** Largest move from the starting point while watched (fraction, signed). */
  maxMove: number | null;
  /** How far the stock had already moved from the previous close when the watch started (fraction). */
  preMove: number | null;
};

export type DayLog = { headlines: HeadlineSeen[]; watches: WatchOutcome[] };

export type MissReason = { code: string; text: string };

export const MISS_LABELS: Record<string, string> = {
  no_news: "No headline tagged with the stock",
  roundup: "Only in roundup headlines",
  not_running: "Monitor wasn't running",
  filtered: "Filtered out (price or liquidity)",
  cooldown: "Already alerted earlier",
  before_headline: "Moved before the headline",
  too_small: "Watched, but too small a move",
  preopen_no_break: "Pre-open news, no opening-range break",
  other: "Other",
};

const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
const et = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** `beforeHeadlinePct`: a stock already this far from the previous close when news arrived "moved before the headline". */
export function missReason(log: DayLog | undefined, monitorStartedAt: number, movePct: number, beforeHeadlinePct = 0.03): MissReason {
  const headlines = log?.headlines ?? [];
  if (headlines.length === 0) {
    return {
      code: "no_news",
      text: "No headline tagged with this stock since the previous close: a sector or market move, news about another company, or news Benzinga didn't carry.",
    };
  }
  const tagged = headlines.filter((h) => !h.roundup);
  if (tagged.length === 0) {
    return { code: "roundup", text: `Only appeared in roundup headlines tagged with many tickers (e.g. "${headlines.at(-1)!.headline}").` };
  }
  const watches = log?.watches ?? [];
  if (watches.length === 0) {
    if (tagged.some((h) => h.at < monitorStartedAt)) {
      return { code: "not_running", text: `Headline at ${et(tagged[0].at)} came out before the monitor (re)started at ${et(monitorStartedAt)}.` };
    }
    return { code: "other", text: "Had a headline but was never watched." };
  }
  const filtered = watches.find((w) => w.outcome.startsWith("filtered"));
  if (filtered) return { code: "filtered", text: `Skipped: ${filtered.outcome.replace(/^filtered: /, "")}.` };
  if (watches.some((w) => w.outcome === "cooldown")) return { code: "cooldown", text: "Had already alerted within the cooldown window." };

  const last = watches.at(-1)!;
  if (last.kind === "preopen") {
    const gap = last.preMove != null ? ` after a ${pct(last.preMove)} gap` : "";
    return { code: "preopen_no_break", text: `Pre-open news${gap}; no break of the opening range by ${et(last.endedAt)}.` };
  }
  if (last.preMove != null && Math.abs(last.preMove) >= beforeHeadlinePct) {
    return {
      code: "before_headline",
      text: `Already ${pct(last.preMove)} from the previous close when the headline arrived at ${et(last.startedAt)}.`,
    };
  }
  const max = last.maxMove != null ? `moved at most ${pct(last.maxMove)}` : "no fresh prices";
  return {
    code: "too_small",
    text: `Watched ${et(last.startedAt)}–${et(last.endedAt)}; ${max} (needs ${(movePct * 100).toFixed(1)}%). The big move came outside that window.`,
  };
}
