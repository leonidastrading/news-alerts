// Is the monitor actually working? Pure rules, so they can be tested: which problems are open now,
// given what the worker has seen. The worker emails when a problem opens and again when it clears.

export type HealthInput = {
  now: number;
  /** Whether the market is open now (from Alpaca's clock, or the weekday 9:30–4:00 guess when that fails). */
  marketOpen: boolean;
  /** Since when Alpaca has been rejecting the keys (401/403), or null if the last request was accepted. */
  authFailingSince: number | null;
  /** Since when the news stream has been down, or null if it's live. */
  streamDownSince: number | null;
  /** When the last headline arrived (stream or REST fallback), and when the market opened today. */
  lastNewsAt: number | null;
  openedAt: number | null;
};

export type Problem = { code: "alpaca_keys" | "news_stream" | "no_news"; text: string };

const min = (ms: number) => Math.round(ms / 60_000);

export function openProblems(h: HealthInput): Problem[] {
  const out: Problem[] = [];
  // Rejected keys break everything, open or closed, so this one counts at any hour.
  if (h.authFailingSince != null && h.now - h.authFailingSince >= 5 * 60_000) {
    out.push({
      code: "alpaca_keys",
      text: `Alpaca has rejected the API keys for ${min(h.now - h.authFailingSince)} minutes (401). If the keys were regenerated or the paper account was reset, put the current pair into ALPACA_KEY_ID and ALPACA_SECRET_KEY on Railway and Vercel.`,
    });
  }
  if (!h.marketOpen) return out;
  if (h.streamDownSince != null && h.now - h.streamDownSince >= 15 * 60_000) {
    out.push({ code: "news_stream", text: `The live news stream has been down for ${min(h.now - h.streamDownSince)} minutes during market hours.` });
  }
  const quietSince = Math.max(h.lastNewsAt ?? 0, h.openedAt ?? 0);
  if (h.openedAt != null && h.now - quietSince >= 30 * 60_000) {
    out.push({ code: "no_news", text: `No headlines have arrived for ${min(h.now - quietSince)} minutes during market hours.` });
  }
  return out;
}

/** Weekday 9:30 AM–4:00 PM New York, for when Alpaca's clock can't be read (ignores holidays). */
export function likelyMarketHours(now: number): boolean {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 570 && m < 960;
}
