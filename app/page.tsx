import { readStatus, recentAlerts, type AlertRow } from "@/lib/db";
import { rideReturn } from "@/lib/detect";

export const dynamic = "force-dynamic";

const pct = (x: number | null, digits = 1) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`);
const usd = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const tone = (x: number | null) => (x == null ? "" : x > 0 ? "pos" : x < 0 ? "neg" : "");
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

type Loaded = { alerts: AlertRow[]; status: Awaited<ReturnType<typeof readStatus>> } | { error: string };

async function load(): Promise<Loaded> {
  if (!process.env.DATABASE_URL) return { error: "No database connected yet. Connect the Neon database to this project in Vercel." };
  try {
    const [alerts, status] = await Promise.all([recentAlerts(30), readStatus()]);
    return { alerts, status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation .* does not exist/.test(msg)) return { error: "The database is empty. It's set up the first time the monitor starts on Railway." };
    return { error: msg };
  }
}

export default async function Page() {
  const data = await load();
  return (
    <>
      <header className="masthead">
        <p className="eyebrow">News Alerts · last 30 days</p>
        <h1>Stocks that moved after a headline</h1>
        <p className="lede">
          When a stock in the news moves {process.env.MOVE_PCT ?? "1.5"}% or more within {process.env.WATCH_MINUTES ?? "30"} minutes of the
          headline, you get an email and the alert is paper-traded in the direction of the move. Each row shows how riding the move
          would have done.
        </p>
      </header>
      {"error" in data ? <div className="notice">{data.error}</div> : <Dashboard alerts={data.alerts} status={data.status} />}
    </>
  );
}

function Dashboard({ alerts, status }: { alerts: AlertRow[]; status: Awaited<ReturnType<typeof readStatus>> }) {
  const r60 = alerts.map((a) => rideReturn(a.direction, a.price, a.price_60m)).filter((x): x is number => x != null);
  const r1d = alerts.map((a) => rideReturn(a.direction, a.price, a.close_1d)).filter((x): x is number => x != null);
  const trades = alerts.filter((a) => a.pnl != null);
  const pnl = trades.reduce((s, a) => s + (a.pnl ?? 0), 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const hit = (xs: number[]) => (xs.length ? `${Math.round((xs.filter((x) => x > 0).length / xs.length) * 100)}%` : "—");
  const stale = status && Date.now() - Date.parse(status.updated_at) > 2 * 3_600_000;

  return (
    <>
      <p className={`status ${!status || stale ? "warn" : ""}`}>
        {status ? (
          <>
            Monitor {stale ? "last" : ""} checked in {ago(status.updated_at)} · news stream {String(status.info.stream)} ·{" "}
            {Number(status.info.newsSeen ?? 0).toLocaleString()} headlines read since it started
            {status.info.lastError ? <> · last error: {String(status.info.lastError)}</> : null}
          </>
        ) : (
          "The monitor hasn't checked in yet."
        )}
      </p>

      <section className="tiles">
        <div className="tile">
          <span className="label">Alerts</span>
          <span className="value">{alerts.length}</span>
        </div>
        <div className="tile">
          <span className="label">Kept going after 60 min</span>
          <span className="value">{hit(r60)}</span>
          <span className="sub">avg {pct(avg(r60), 2)} riding the move</span>
        </div>
        <div className="tile">
          <span className="label">Kept going to next close</span>
          <span className="value">{hit(r1d)}</span>
          <span className="sub">avg {pct(avg(r1d), 2)} riding the move</span>
        </div>
        <div className="tile">
          <span className="label">Paper P&amp;L</span>
          <span className={`value ${tone(pnl)}`}>{trades.length ? usd(pnl) : "—"}</span>
          <span className="sub">{trades.length} closed trades</span>
        </div>
      </section>

      {alerts.length === 0 ? (
        <div className="notice">No alerts yet. They appear here as soon as a stock in the news moves.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Alert (ET)</th>
                <th>Stock</th>
                <th>Headline</th>
                <th className="num">At alert</th>
                <th className="num">+15 min</th>
                <th className="num">+60 min</th>
                <th className="num">Next close</th>
                <th className="num">Paper trade</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => {
                const lag = (Date.parse(a.alerted_at) - Date.parse(a.news_at)) / 60_000;
                return (
                  <tr key={a.id}>
                    <td className="nowrap">{fmtTime(a.alerted_at)}</td>
                    <td>
                      <strong>{a.symbol}</strong>
                      <span className={`dir ${a.direction > 0 ? "pos" : "neg"}`}>{a.direction > 0 ? "▲" : "▼"}</span>
                    </td>
                    <td className="headline">
                      <a href={a.url} target="_blank" rel="noreferrer">
                        {a.headline}
                      </a>
                      <span className="meta">
                        {a.source} · alert {Math.round(lag)} min after the headline
                      </span>
                    </td>
                    <td className={`num ${tone(a.move_pct)}`}>
                      {pct(a.move_pct)}
                      <span className="meta">${a.price.toFixed(2)}</span>
                    </td>
                    <Ride a={a} later={a.price_15m} />
                    <Ride a={a} later={a.price_60m} />
                    <Ride a={a} later={a.close_1d} />
                    <td className="num">
                      <Trade a={a} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">
        +15 min, +60 min and Next close show the return from the alert price if you had ridden the move: positive means the stock kept
        going the way it was moving. Prices are from IEX, a single exchange, so thin stocks can print a little off the consolidated
        price.
      </p>
    </>
  );
}

function Ride({ a, later }: { a: AlertRow; later: number | null }) {
  const r = rideReturn(a.direction, a.price, later);
  return (
    <td className={`num ${tone(r)}`}>
      {r == null ? (a.results_done ? "n/a" : "…") : pct(r)}
      {later != null && <span className="meta">${later.toFixed(2)}</span>}
    </td>
  );
}

function Trade({ a }: { a: AlertRow }) {
  if (!a.trade_status) return <>—</>;
  if (a.trade_status.startsWith("skipped") || a.trade_status === "error")
    return <span className="meta">{a.trade_status}</span>;
  const side = a.direction > 0 ? "Long" : "Short";
  if (a.pnl != null)
    return (
      <>
        <span className={tone(a.pnl)}>{usd(a.pnl)}</span>
        <span className="meta">
          {side} {a.qty} · ${a.entry_price?.toFixed(2)} → ${a.exit_price?.toFixed(2)}
        </span>
      </>
    );
  return (
    <>
      {a.trade_status === "open" ? "Open" : "Closing"}
      <span className="meta">
        {side} {a.qty}
        {a.entry_price != null && <> @ ${a.entry_price.toFixed(2)}</>}
      </span>
    </>
  );
}
