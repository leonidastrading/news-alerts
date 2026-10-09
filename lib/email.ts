// Alert emails through Resend. Without a verified domain Resend can only send from
// onboarding@resend.dev to the address the Resend account was created with.
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type AlertEmail = {
  symbol: string;
  movePct: number;
  minutesAfterNews: number;
  baseline: number;
  price: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  trade: string;
};

export function alertSubject(a: AlertEmail): string {
  return `${a.symbol} ${pct(a.movePct)} · ${Math.round(a.minutesAfterNews)} min after: ${a.headline}`.slice(0, 180);
}

export function alertHtml(a: AlertEmail, dashboardUrl: string): string {
  return `<div style="font:15px/1.5 system-ui,sans-serif;max-width:560px">
  <p style="margin:0 0 4px;font-size:13px;color:#7a7873">News alert</p>
  <h2 style="margin:0 0 8px;font-size:22px">${esc(a.symbol)} ${pct(a.movePct)}</h2>
  <p style="margin:0 0 12px;color:#52514e">From $${a.baseline.toFixed(2)} when the headline arrived to $${a.price.toFixed(2)},
  ${Math.round(a.minutesAfterNews)} minutes later.</p>
  <p style="margin:0 0 4px"><a href="${esc(a.url)}" style="color:#2a78d6;font-weight:600">${esc(a.headline)}</a></p>
  ${a.summary ? `<p style="margin:0 0 4px;color:#52514e">${esc(a.summary)}</p>` : ""}
  <p style="margin:0 0 16px;font-size:13px;color:#7a7873">${esc(a.source)}</p>
  <p style="margin:0 0 16px">Paper trade: ${esc(a.trade)}</p>
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
