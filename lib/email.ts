// Alert emails through Resend. Without a verified domain Resend can only send from
// onboarding@resend.dev to the address the Resend account was created with.
import type { NewAlert } from "./db.ts";

const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const shares = (x: number | null) => (x == null ? "—" : Math.round(x).toLocaleString("en-US"));
const et = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/New_York" });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type AlertEmail = NewAlert & { minutesAfterNews: number; trade: string };

export function alertSubject(a: AlertEmail): string {
  if (a.kind === "preopen") {
    const gap = a.gapPct != null ? ` after a ${pct(a.gapPct)} gap` : "";
    return `${a.symbol} broke ${a.direction > 0 ? "above" : "below"} its opening range${gap}: ${a.headline}`.slice(0, 180);
  }
  return `${a.symbol} ${pct(a.movePct)} · ${Math.round(a.minutesAfterNews)} min after: ${a.headline}`.slice(0, 180);
}

function whatHappened(a: AlertEmail): string {
  if (a.kind === "preopen") {
    const gap = a.prevClose != null && a.gapPct != null ? `Closed at ${usd(a.prevClose)} yesterday, opened at ${usd(a.openPrice!)} (${pct(a.gapPct)}). ` : "";
    return `${gap}Opening range ${usd(a.rangeLow!)}–${usd(a.rangeHigh!)}; now ${usd(a.price)}, ${a.direction > 0 ? "above" : "below"} it
      (${pct(a.movePct)} from the open).`;
  }
  return `From ${usd(a.baseline)} when the headline arrived to ${usd(a.price)}, ${Math.round(a.minutesAfterNews)} minutes after it was published.`;
}

export function alertHtml(a: AlertEmail, dashboardUrl: string): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#7a7873;white-space:nowrap">${k}</td><td style="padding:2px 0">${v}</td></tr>`;
  const title = a.kind === "preopen" ? `${a.symbol} ${a.direction > 0 ? "▲ broke out" : "▼ broke down"}` : `${a.symbol} ${pct(a.movePct)}`;
  return `<div style="font:15px/1.5 system-ui,sans-serif;max-width:600px">
  <p style="margin:0 0 4px;font-size:13px;color:#7a7873">${a.kind === "preopen" ? "Pre-open news · opening-range break" : "News alert"} · ${esc(a.category)} · ${esc(a.origin)}</p>
  <h2 style="margin:0 0 8px;font-size:22px">${esc(title)}</h2>
  <p style="margin:0 0 12px;color:#52514e">${whatHappened(a)}</p>
  <p style="margin:0 0 4px"><a href="${esc(a.url)}" style="color:#2a78d6;font-weight:600">${esc(a.headline)}</a></p>
  ${a.summary ? `<p style="margin:0 0 4px;color:#52514e">${esc(a.summary)}</p>` : ""}
  <p style="margin:0 0 16px;font-size:13px;color:#7a7873">${esc(a.source)}${a.newsCount > 1 ? ` · ${a.newsCount} headlines about ${esc(a.symbol)} since the last close` : ""}</p>
  <table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">
    ${row("News published", `${et(Date.parse(a.newsAt))} ET`)}
    ${row("Alert", `${et(a.alertedAt.getTime())} ET`)}
    ${row("Volume (IEX)", `${shares(a.volumeSince)} ${a.kind === "preopen" ? "since the open" : "since the headline"} · ${shares(a.dayVolume)} today · ${shares(a.prevDayVolume)} yesterday`)}
    ${row("Paper trade", esc(a.trade))}
  </table>
  ${dashboardUrl ? `<p style="margin:0"><a href="${esc(dashboardUrl)}" style="color:#2a78d6">All alerts and results</a></p>` : ""}
</div>`;
}

export async function sendAlertEmail(a: AlertEmail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!key || !to) throw new Error("RESEND_API_KEY and ALERT_EMAIL must be set to send email");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ALERT_FROM || "News Alerts <onboarding@resend.dev>",
      to: [to],
      subject: alertSubject(a),
      html: alertHtml(a, process.env.DASHBOARD_URL ?? ""),
    }),
  });
  if (!res.ok) throw new Error(`Resend: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
