import { readStatus, recentAlerts, recentMisses, type AlertRow, type MissRow } from "@/lib/db";
import { MISS_LABELS } from "@/lib/misses";
import { ORIGINS } from "@/lib/origin";
import { rideReturn } from "@/lib/detect";
import { positions as fetchPositions, type Position } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

const pct = (x: number | null | undefined, digits = 1) =>
  x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
const usd = (x: number | null | undefined) => (x == null ? "—" : `$${x.toFixed(2)}`);
const pnlUsd = (x: number | null | undefined) =>
  x == null ? "—" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd0 = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString("en-US")}`);
const shares = (x: number | null | undefined) =>
  x == null ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(x);
const tone = (x: number | null | undefined) => (x == null ? "" : x > 0 ? "pos" : x < 0 ? "neg" : "");

const ET = "America/New_York";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: ET });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: ET });
const gap = (fromIso: string, toIso: string) => {
  const s = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000);
  if (!Number.isFinite(s)) return "";
  const sign = s < 0 ? "−" : "+";
  const a = Math.abs(s);
  if (a < 60) return `${sign}${a}s`;
  if (a < 3600) return `${sign}${Math.floor(a / 60)}m ${a % 60}s`;
  if (a < 86_400) return `${sign}${Math.floor(a / 3600)}h ${Math.floor((a % 3600) / 60)}m`;
  return `${sign}${Math.floor(a / 86_400)}d ${Math.floor((a % 86_400) / 3600)}h`;
};
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

type Status = Awaited<ReturnType<typeof readStatus>>;
type Loaded = { alerts: AlertRow[]; misses: MissRow[]; status: Status } | { error: string };

async function load(): Promise<Loaded> {
  if (!process.env.DATABASE_URL) return { error: "No database connected yet. Connect the Neon database to this project in Vercel." };
  try {
    const [alerts, status, misses] = await Promise.all([
      recentAlerts(30),
      readStatus(),
      recentMisses(30).catch((e) => {
        // The table appears once the monitor has started; anything else is a real error worth seeing.
        if (!/relation .* does not exist/.test(String(e))) console.error("missed moves query failed", e);
        return [] as MissRow[];
      }),
    ]);
    return { alerts, misses, status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation .* does not exist/.test(msg)) return { error: "The database is empty. It's set up the first time the monitor starts on Railway." };
    return { error: msg };
  }
}

type Positions = { list: Position[] } | { note: string };

async function loadPositions(): Promise<Positions> {
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
    return { note: "Add ALPACA_KEY_ID and ALPACA_SECRET_KEY to this Vercel project to see live positions." };
  }
  try {
    return { list: await fetchPositions() };
  } catch (e) {
    return { note: `Couldn't load positions from Alpaca: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default async function Page() {
  const [data, positions] = await Promise.all([load(), loadPositions()]);
  return (
    <>
      <header className="masthead">
        <p className="eyebrow">News Alerts · last 30 days</p>
        <h1>Stocks that moved after a headline</h1>
        <p className="lede">
          <strong>Intraday news:</strong> when a stock moves {process.env.MOVE_PCT ?? "1.5"}% from where it was when the headline arrived.{" "}
          <strong>News from while the market was closed:</strong> when a stock breaks out of its first {process.env.OPEN_RANGE_MINUTES ?? "5"}{" "}
          minutes&rsquo; range after the open. Each alert is emailed and paper-traded in the direction of the move with a limit order, held to the end of the
          day and closed at the closing price. No new trades after 3:45 PM; later alerts are only logged.
        </p>
      </header>
      {"error" in data ? <div className="notice">{data.error}</div> : <Dashboard alerts={data.alerts} misses={data.misses} status={data.status} positions={positions} />}
    </>
  );
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const share = (xs: number[]) => (xs.length ? `${Math.round((xs.filter((x) => x > 0).length / xs.length) * 100)}%` : "—");

function summarize(alerts: AlertRow[]) {
  const r60 = alerts.map((a) => rideReturn(a.direction, a.price, a.price_60m)).filter((x): x is number => x != null);
  const r0d = alerts.map((a) => rideReturn(a.direction, a.price, a.close_0d)).filter((x): x is number => x != null);
  const r1d = alerts.map((a) => rideReturn(a.direction, a.price, a.close_1d)).filter((x): x is number => x != null);
  const closed = alerts.filter((a) => a.pnl != null);
  return {
    count: alerts.length,
    traded: alerts.filter((a) => a.entry_order_id).length,
    closed: closed.length,
    wins: closed.length ? `${Math.round((closed.filter((a) => a.pnl! > 0).length / closed.length) * 100)}%` : "—",
    pnl: closed.length ? closed.reduce((s, a) => s + a.pnl!, 0) : null,
    kept60: share(r60),
    avg60: avg(r60),
    kept0d: share(r0d),
    avg0d: avg(r0d),
    kept1d: share(r1d),
    avg1d: avg(r1d),
  };
}

const nyMinutes = (iso: string) => {
  const [h, m] = new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ET }).split(":").map(Number);
  return h * 60 + m;
};
const nyDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: ET });

function Dashboard({ alerts, misses: allMisses, status, positions }: { alerts: AlertRow[]; misses: MissRow[]; status: Status; positions: Positions }) {
  const all = summarize(alerts);
  // A stock that alerted later the same day isn't a miss.
  const alertedDays = new Set(alerts.map((a) => `${nyDay(a.alerted_at)} ${a.symbol}`));
  const misses = allMisses.filter((m) => !alertedDays.has(`${m.day} ${m.symbol}`));
  const timeGroups: [string, AlertRow[]][] = [
    ["Open – 10:30 AM", alerts.filter((a) => nyMinutes(a.alerted_at) < 630)],
    ["10:30 AM – 3:00 PM", alerts.filter((a) => nyMinutes(a.alerted_at) >= 630 && nyMinutes(a.alerted_at) < 900)],
    ["Late session · 3:00 PM – close", alerts.filter((a) => nyMinutes(a.alerted_at) >= 900)],
  ];
  const indexGroups = (
    [
      ["S&P 500", alerts.filter((a) => a.sp500 === true)],
      ["Not in the S&P 500", alerts.filter((a) => a.sp500 === false)],
      ["Not tagged (before the S&P 500 tag)", alerts.filter((a) => a.sp500 == null)],
    ] as [string, AlertRow[]][]
  ).filter(([, rows]) => rows.length > 0);
  const stale = status && Date.now() - Date.parse(status.updated_at) > 2 * 3_600_000;
  const originGroups: [string, AlertRow[]][] = ORIGINS.map((o): [string, AlertRow[]] => [o, alerts.filter((a) => (a.origin ?? "Other") === o)]).filter(
    ([, rows]) => rows.length > 0,
  );
  const groups: [string, AlertRow[]][] = [
    ["Intraday · long", alerts.filter((a) => a.kind !== "preopen" && a.direction > 0)],
    ["Intraday · short", alerts.filter((a) => a.kind !== "preopen" && a.direction < 0)],
    ["Pre-open · long", alerts.filter((a) => a.kind === "preopen" && a.direction > 0)],
    ["Pre-open · short", alerts.filter((a) => a.kind === "preopen" && a.direction < 0)],
  ];

  return (
    <>
      <p className={`status ${!status || stale ? "warn" : ""}`}>
        {status ? (
          <>
            Monitor {stale ? "last" : ""} checked in {ago(status.updated_at)} · news stream {String(status.info.stream)} ·{" "}
            {Number(status.info.newsSeen ?? 0).toLocaleString()} headlines read since it started
            {(() => {
              const m = status.info.lastMissScan as { at?: string; checked?: number; bigMovers?: number } | undefined;
              return m?.at ? <> · missed-move check {ago(m.at)}: {m.checked} stocks, {m.bigMovers} big movers</> : null;
            })()}
            {status.info.lastError ? <> · last error: {String(status.info.lastError)}</> : null}
          </>
        ) : (
          "The monitor hasn't checked in yet."
        )}
      </p>

      <section className="tiles">
        <div className="tile">
          <span className="label">Alerts</span>
          <span className="value">{all.count}</span>
          <span className="sub">{all.traded} paper-traded</span>
        </div>
        <div className="tile">
          <span className="label">Paper P&amp;L</span>
          <span className={`value ${tone(all.pnl)}`}>{pnlUsd(all.pnl)}</span>
          <span className="sub">
            {all.closed} closed trades · {all.wins} winners
          </span>
        </div>
        <div className="tile">
          <span className="label">Kept going after 60 min</span>
          <span className="value">{all.kept60}</span>
          <span className="sub">avg {pct(all.avg60, 2)} riding the move</span>
        </div>
        <div className="tile">
          <span className="label">Kept going to the close</span>
          <span className="value">{all.kept0d}</span>
          <span className="sub">avg {pct(all.avg0d, 2)} riding the move</span>
        </div>
        <div className="tile">
          <span className="label">Kept going to next close</span>
          <span className="value">{all.kept1d}</span>
          <span className="sub">avg {pct(all.avg1d, 2)} riding the move</span>
        </div>
        <a className="tile link" href="#missed">
          <span className="label">Missed moves</span>
          <span className="value">{misses.length}</span>
          <span className="sub">stocks ±{process.env.MISS_MOVE_PCT ?? "5"}% on the day with no alert</span>
        </a>
      </section>

      <OpenPositions positions={positions} alerts={alerts} />

      {alerts.length > 0 && <Breakdown heading="News · side" groups={groups} />}
      {alerts.length > 0 && <Breakdown heading="News origin" groups={originGroups} />}
      {alerts.length > 0 && <Breakdown heading="Time of day" groups={timeGroups} />}
      {alerts.length > 0 && <Breakdown heading="Index" groups={indexGroups} />}

      {alerts.length === 0 ? (
        <div className="notice">No alerts yet. They appear here as soon as a stock in the news moves.</div>
      ) : (
        <div className="alerts">
          {alerts.map((a) => (
            <AlertCard key={a.id} a={a} />
          ))}
        </div>
      )}
      <Missed misses={misses} />

      <p className="footnote">
        Times are New York time. Prices and volumes are from IEX, a single exchange (about 2–3% of all US trading), so volumes are a
        fraction of the consolidated tape and thin stocks can print a little off the consolidated price. &ldquo;Riding the move&rdquo;
        is the return from the alert price in the alert&rsquo;s direction: positive means the stock kept going the way it was moving.
      </p>
    </>
  );
}

function AlertCard({ a }: { a: AlertRow }) {
  const pre = a.kind === "preopen";
  const long = a.direction > 0;
  const tradePct = a.entry_price && a.exit_price ? rideReturn(a.direction, a.entry_price, a.exit_price) : null;
  // Positive = filled worse than the alert price (paid up on a long, sold lower on a short).
  const slip = a.entry_price ? rideReturn(a.direction, a.price, a.entry_price) : null;
  const times: [string, string | null][] = [
    ["News published", a.news_at],
    [pre ? "Picked up at the open" : "Received", a.seen_at],
    ["Alert", a.alerted_at],
    ["Entry order sent", a.entry_submitted_at],
    ["Entry filled", a.entry_filled_at],
    ["Exit order sent", a.exit_at],
    ["Exit filled", a.exit_filled_at],
  ];

  return (
    <article className="card" id={`alert-${a.id}`}>
      <header className="card-head">
        <div className="who">
          <span className="sym">{a.symbol}</span>
          <span className={`badge ${long ? "pos" : "neg"}`}>{long ? "▲ Long" : "▼ Short"}</span>
          <span className="badge">{pre ? "Pre-open news" : "Intraday news"}</span>
          {a.category && <span className="badge">{a.category}</span>}
          {a.origin && <span className={`badge origin ${a.origin.startsWith("Reactive") ? "late" : ""}`}>{a.origin}</span>}
          {a.sp500 && <span className="badge">S&amp;P 500</span>}
          {nyMinutes(a.alerted_at) >= 900 && <span className="badge">Late session</span>}
        </div>
        <div className="when">
          {day(a.alerted_at)} · {clock(a.alerted_at)} ET
        </div>
        <div className={`pnl ${tone(a.pnl)}`}>
          {a.pnl != null ? (
            <>
              {pnlUsd(a.pnl)} <span className="meta-inline">{pct(tradePct, 2)}</span>
            </>
          ) : (
            <span className="meta-inline">{tradeLabel(a)}</span>
          )}
        </div>
      </header>

      <div className="news">
        <a href={a.url} target="_blank" rel="noreferrer">
          {a.headline}
        </a>
        {a.summary && <p>{a.summary}</p>}
        <span className="meta">
          {a.source}
          {a.news_count && a.news_count > 1 ? ` · ${a.news_count} headlines about ${a.symbol} since the last close` : ""}
        </span>
      </div>

      <div className="grid">
        <section>
          <h3>Timeline (ET)</h3>
          <dl>
            {times.map(([label, iso]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {iso ? (
                    <>
                      {day(iso) !== day(a.alerted_at) && <>{day(iso)} </>}
                      {clock(iso)}
                      {label !== "News published" && a.news_at && <span className="meta-inline"> {gap(a.news_at, iso)}</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h3>Price</h3>
          <dl>
            {pre ? (
              <>
                <div>
                  <dt>Previous close</dt>
                  <dd>{usd(a.prev_close)}</dd>
                </div>
                <div>
                  <dt>Open</dt>
                  <dd>
                    {usd(a.open_price)} <span className={`meta-inline ${tone(a.gap_pct)}`}>gap {pct(a.gap_pct)}</span>
                  </dd>
                </div>
                <div>
                  <dt>Opening range</dt>
                  <dd>
                    {usd(a.range_low)} – {usd(a.range_high)}
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>Previous close</dt>
                  <dd>{usd(a.prev_close)}</dd>
                </div>
                <div>
                  <dt>When the news arrived</dt>
                  <dd>{usd(a.baseline)}</dd>
                </div>
              </>
            )}
            <div>
              <dt>At the alert</dt>
              <dd>
                {usd(a.price)}{" "}
                <span className={`meta-inline ${tone(a.move_pct)}`}>
                  {pct(a.move_pct)} {pre ? "from the open" : "from the news"}
                </span>
              </dd>
            </div>
          </dl>
          <h3>Volume (IEX shares)</h3>
          <dl>
            <div>
              <dt>{pre ? "Since the open" : "Since the headline"}</dt>
              <dd>{shares(a.volume_since)}</dd>
            </div>
            {pre && (
              <div>
                <dt>In the opening range</dt>
                <dd>{shares(a.range_volume)}</dd>
              </div>
            )}
            <div>
              <dt>Today at the alert</dt>
              <dd>{shares(a.day_volume)}</dd>
            </div>
            <div>
              <dt>Yesterday (full day)</dt>
              <dd>
                {shares(a.prev_day_volume)}
                {a.day_volume && a.prev_day_volume ? (
                  <span className="meta-inline"> today {(a.day_volume / a.prev_day_volume).toFixed(1)}×</span>
                ) : null}
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>Paper trade</h3>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{tradeLabel(a)}</dd>
            </div>
            <div>
              <dt>Shares</dt>
              <dd>{a.qty ?? "—"}</dd>
            </div>
            <div>
              <dt>Entry fill</dt>
              <dd>
                {usd(a.entry_price)}
                {slip != null && <span className={`meta-inline ${tone(-slip)}`}> slippage {pct(slip, 2)}</span>}
              </dd>
            </div>
            <div>
              <dt>Exit fill</dt>
              <dd>{usd(a.exit_price)}</dd>
            </div>
            <div>
              <dt>P&amp;L</dt>
              <dd className={tone(a.pnl)}>
                {pnlUsd(a.pnl)} {tradePct != null && <span className="meta-inline">{pct(tradePct, 2)}</span>}
              </dd>
            </div>
          </dl>
          <h3>Riding the move from the alert</h3>
          <dl>
            <Ride label="+15 min" a={a} later={a.price_15m} />
            <Ride label="+60 min" a={a} later={a.price_60m} />
            <Ride label="That day's close" a={a} later={a.close_0d} />
            <Ride label="Next close" a={a} later={a.close_1d} />
          </dl>
        </section>
      </div>
    </article>
  );
}

function tradeLabel(a: AlertRow): string {
  if (!a.trade_status) return "Not traded";
  if (a.trade_status.startsWith("skipped") || a.trade_status.startsWith("error")) return a.trade_status.replace(/^skipped: /, "Skipped: ").replace(/^error/, "Error");
  if (a.trade_status === "open") return a.entry_price != null ? "Open" : "Order sent";
  return a.exit_price != null ? "Closed" : "Closing";
}

function Ride({ label, a, later }: { label: string; a: AlertRow; later: number | null }) {
  const r = rideReturn(a.direction, a.price, later);
  return (
    <div>
      <dt>{label}</dt>
      <dd className={tone(r)}>
        {r == null ? (a.results_done ? "n/a" : "pending") : pct(r, 2)}
        {later != null && <span className="meta-inline"> {usd(later)}</span>}
      </dd>
    </div>
  );
}

function Missed({ misses }: { misses: MissRow[] }) {
  const counts = new Map<string, number>();
  for (const m of misses) counts.set(m.reason_code, (counts.get(m.reason_code) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return (
    <section id="missed" className="missed">
      <h2>Missed moves</h2>
      <p className="section-lede">
        Every 5 minutes during the session the monitor checks the day&rsquo;s biggest gainers and losers. A stock that&rsquo;s up or down{" "}
        {process.env.MISS_MOVE_PCT ?? "5"}% or more, trades enough to have been watched and had no alert is recorded here with the
        reason it was missed.
      </p>
      {misses.length === 0 ? (
        <div className="notice">No missed moves recorded yet.</div>
      ) : (
        <>
          <div className="reasons">
            {ranked.map(([code, n]) => (
              <span key={code} className="reason">
                <strong>{n}</strong> {MISS_LABELS[code] ?? code}
              </span>
            ))}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Stock</th>
                  <th className="num">Day move</th>
                  <th className="num">Price</th>
                  <th className="num">IEX volume</th>
                  <th>Why no alert</th>
                  <th>Latest headline</th>
                </tr>
              </thead>
              <tbody>
                {misses.map((m) => (
                  <tr key={m.id}>
                    <td className="nowrap">
                      {new Date(`${m.day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                      <span className="meta">first seen {clock(m.detected_at)}</span>
                    </td>
                    <td>
                      <strong>{m.symbol}</strong>
                      {m.sp500 && <span className="meta">S&amp;P 500</span>}
                    </td>
                    <td className={`num ${tone(m.day_change_pct)}`}>{pct(m.day_change_pct)}</td>
                    <td className="num">
                      {usd(m.price)}
                      <span className="meta">prev {usd(m.prev_close)}</span>
                    </td>
                    <td className="num">{shares(m.day_volume)}</td>
                    <td className="why-cell">
                      <span className="badge">{MISS_LABELS[m.reason_code] ?? m.reason_code}</span>
                      <span className="meta">{m.reason_text}</span>
                    </td>
                    <td className="headline">
                      {m.headline ? (
                        <>
                          <a href={m.url ?? "#"} target="_blank" rel="noreferrer">
                            {m.headline}
                          </a>
                          {m.origin && <span className={`badge origin ${m.origin.startsWith("Reactive") ? "late" : ""}`}>{m.origin}</span>}
                          {m.news_at && (
                            <span className="meta">
                              {day(m.news_at)} {clock(m.news_at)} ET
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="meta">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Breakdown({ heading, groups }: { heading: string; groups: [string, AlertRow[]][] }) {
  return (
    <div className="table-wrap breakdown">
      <table>
        <thead>
          <tr>
            <th>{heading}</th>
            <th className="num">Alerts</th>
            <th className="num">Closed trades</th>
            <th className="num">Winners</th>
            <th className="num">Paper P&amp;L</th>
            <th className="num">Kept going 60 min</th>
            <th className="num">Avg 60 min</th>
            <th className="num">Avg to the close</th>
            <th className="num">Avg next close</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(([label, rows]) => {
            const g = summarize(rows);
            return (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{g.count}</td>
                <td className="num">{g.closed}</td>
                <td className="num">{g.wins}</td>
                <td className={`num ${tone(g.pnl)}`}>{pnlUsd(g.pnl)}</td>
                <td className="num">{g.kept60}</td>
                <td className={`num ${tone(g.avg60)}`}>{pct(g.avg60, 2)}</td>
                <td className={`num ${tone(g.avg0d)}`}>{pct(g.avg0d, 2)}</td>
                <td className={`num ${tone(g.avg1d)}`}>{pct(g.avg1d, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OpenPositions({ positions, alerts }: { positions: Positions; alerts: AlertRow[] }) {
  if ("note" in positions) return <div className="notice small">{positions.note}</div>;
  const list = positions.list;
  const num = (x: string) => Number(x);
  const total = list.reduce((t, p) => t + num(p.unrealized_pl), 0);
  const cost = list.reduce((t, p) => t + Math.abs(num(p.cost_basis)), 0);
  // The most recent alert that opened a trade in this symbol.
  const alertFor = (sym: string) => alerts.find((a) => a.symbol === sym && a.entry_order_id);
  return (
    <section className="positions">
      <div className="positions-head">
        <h2>Open positions</h2>
        {list.length > 0 && (
          <span className={`positions-total ${tone(total)}`}>
            {pnlUsd(total)} <span className="meta-inline">{pct(cost ? total / cost : null, 2)} on {usd0(cost)}</span>
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <div className="notice small">No open paper positions.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stock</th>
                <th className="num">P&amp;L</th>
                <th className="num">P&amp;L %</th>
                <th className="num">Shares</th>
                <th className="num">Entry</th>
                <th className="num">Now</th>
                <th className="num">Value</th>
                <th>Opened by</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const pl = num(p.unrealized_pl);
                const a = alertFor(p.symbol);
                return (
                  <tr key={p.symbol}>
                    <td className="nowrap">
                      <strong>{p.symbol}</strong>
                      <span className={`dir ${p.side === "long" ? "pos" : "neg"}`}>{p.side === "long" ? "▲ Long" : "▼ Short"}</span>
                    </td>
                    <td className={`num ${tone(pl)}`}>{pnlUsd(pl)}</td>
                    <td className={`num ${tone(pl)}`}>{pct(num(p.unrealized_plpc), 2)}</td>
                    <td className="num">{Math.abs(num(p.qty))}</td>
                    <td className="num">{usd(num(p.avg_entry_price))}</td>
                    <td className="num">{usd(num(p.current_price))}</td>
                    <td className="num">{usd0(Math.abs(num(p.market_value)))}</td>
                    <td className="headline">
                      {a ? (
                        <a href={`#alert-${a.id}`}>
                          {clock(a.alerted_at)} · {a.headline}
                        </a>
                      ) : (
                        <span className="meta">Not opened by an alert on this page</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">Live from the Alpaca paper account each time the page loads. Positions close automatically at the closing price (a market-on-close order sent about 12 minutes before the close).</p>
    </section>
  );
}
