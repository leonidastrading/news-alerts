// New York time helpers: trading hours, sessions and results are all in exchange time.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(ms: number) {
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** YYYY-MM-DD in New York. */
export const nyDate = (ms: number) => parts(ms).date;

/** UTC milliseconds for a New York wall-clock time, e.g. ("2026-10-09", "09:30"). */
export function nyToUtc(date: string, hhmm: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, hh + offset, mm);
    const p = parts(t);
    if (p.date === date && p.hour === hh && p.minute === mm) return t;
  }
  return Date.UTC(y, m - 1, d, hh + 5, mm);
}
