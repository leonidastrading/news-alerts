// Neon Postgres. The worker writes alerts and results; the website reads them. Kept to a few
// queries an hour when nothing is happening, so the free plan's compute hours last the month.
import { neon } from "@neondatabase/serverless";

export type AlertRow = {
  id: number;
  symbol: string;
  direction: number;
  news_id: number | null;
  headline: string;
  url: string;
  source: string;
  news_at: string;
  seen_at: string;
  alerted_at: string;
  baseline: number;
  price: number;
  move_pct: number;
  trade_status: string | null;
  qty: number | null;
  entry_order_id: string | null;
  entry_price: number | null;
  exit_order_id: string | null;
  exit_price: number | null;
  exit_at: string | null;
  pnl: number | null;
  price_15m: number | null;
  price_60m: number | null;
  close_1d: number | null;
  results_done: boolean;
};

// The driver returns timestamps as Date objects; the rest of the app works with ISO strings.
function rowsOut<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))) as T[];
}

export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  return neon(url);
}

export async function migrate() {
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS alerts (
    id serial PRIMARY KEY,
    symbol text NOT NULL,
    direction smallint NOT NULL,
    news_id bigint,
    headline text NOT NULL DEFAULT '',
    url text NOT NULL DEFAULT '',
    source text NOT NULL DEFAULT '',
    news_at timestamptz,
    seen_at timestamptz,
    alerted_at timestamptz NOT NULL,
    baseline double precision NOT NULL,
    price double precision NOT NULL,
    move_pct double precision NOT NULL,
    trade_status text,
    qty integer,
    entry_order_id text,
    entry_price double precision,
    exit_order_id text,
    exit_price double precision,
    exit_at timestamptz,
    pnl double precision,
    price_15m double precision,
    price_60m double precision,
    close_1d double precision,
    results_done boolean NOT NULL DEFAULT false
  )`;
  await sql`CREATE INDEX IF NOT EXISTS alerts_alerted_at ON alerts (alerted_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS worker_status (
    id integer PRIMARY KEY,
    updated_at timestamptz NOT NULL,
    info jsonb NOT NULL
  )`;
}

export async function insertAlert(a: {
  symbol: string;
  direction: number;
  newsId: number;
  headline: string;
  url: string;
  source: string;
  newsAt: string;
  seenAt: Date;
  alertedAt: Date;
  baseline: number;
  price: number;
  movePct: number;
}): Promise<number> {
  const rows = await db()`INSERT INTO alerts
    (symbol, direction, news_id, headline, url, source, news_at, seen_at, alerted_at, baseline, price, move_pct)
    VALUES (${a.symbol}, ${a.direction}, ${a.newsId}, ${a.headline}, ${a.url}, ${a.source}, ${a.newsAt},
            ${a.seenAt.toISOString()}, ${a.alertedAt.toISOString()}, ${a.baseline}, ${a.price}, ${a.movePct})
    RETURNING id`;
  return rows[0].id as number;
}

export async function setTradeOpened(id: number, status: string, qty: number | null, orderId: string | null) {
  await db()`UPDATE alerts SET trade_status = ${status}, qty = ${qty}, entry_order_id = ${orderId} WHERE id = ${id}`;
}

export async function setEntryFill(id: number, price: number) {
  await db()`UPDATE alerts SET entry_price = ${price} WHERE id = ${id}`;
}

export async function setTradeClosed(id: number, exitOrderId: string | null, at: Date) {
  await db()`UPDATE alerts SET trade_status = 'closed', exit_order_id = ${exitOrderId}, exit_at = ${at.toISOString()} WHERE id = ${id}`;
}

export async function setExitFill(id: number, price: number, pnl: number) {
  await db()`UPDATE alerts SET exit_price = ${price}, pnl = ${pnl} WHERE id = ${id}`;
}

export async function setResults(id: number, r: { price15m: number | null; price60m: number | null; close1d: number | null; done: boolean }) {
  await db()`UPDATE alerts SET price_15m = ${r.price15m}, price_60m = ${r.price60m}, close_1d = ${r.close1d},
    results_done = ${r.done} WHERE id = ${id}`;
}

/** Alerts the worker still has to follow up on: open trades, missing fills, missing results. */
export async function pendingAlerts(): Promise<AlertRow[]> {
  return rowsOut<AlertRow>(await db()`SELECT * FROM alerts
    WHERE NOT results_done OR trade_status = 'open'
       OR (entry_order_id IS NOT NULL AND entry_price IS NULL)
       OR (exit_order_id IS NOT NULL AND exit_price IS NULL)
    ORDER BY alerted_at`);
}

export async function recentAlerts(days = 30): Promise<AlertRow[]> {
  return rowsOut<AlertRow>(await db()`SELECT * FROM alerts WHERE alerted_at > now() - make_interval(days => ${days})
    ORDER BY alerted_at DESC LIMIT 500`);
}

export async function lastAlertTimes(): Promise<Record<string, number>> {
  const rows = await db()`SELECT symbol, max(alerted_at) AS at FROM alerts
    WHERE alerted_at > now() - interval '1 day' GROUP BY symbol`;
  return Object.fromEntries(rowsOut<{ symbol: string; at: string }>(rows).map((r) => [r.symbol, Date.parse(r.at)]));
}

export async function writeStatus(info: Record<string, unknown>) {
  await db()`INSERT INTO worker_status (id, updated_at, info) VALUES (1, now(), ${JSON.stringify(info)})
    ON CONFLICT (id) DO UPDATE SET updated_at = now(), info = EXCLUDED.info`;
}

export async function readStatus(): Promise<{ updated_at: string; info: Record<string, unknown> } | null> {
  const rows = rowsOut<{ updated_at: string; info: Record<string, unknown> }>(await db()`SELECT updated_at, info FROM worker_status WHERE id = 1`);
  return rows[0] ?? null;
}
