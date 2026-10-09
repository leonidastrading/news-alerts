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
  /** "intraday" (news while open) or "preopen" (news while closed, traded on an opening-range break). */
  kind: string;
  category: string | null;
  summary: string | null;
  news_count: number | null;
  prev_close: number | null;
  open_price: number | null;
  gap_pct: number | null;
  range_high: number | null;
  range_low: number | null;
  range_volume: number | null;
  /** IEX shares: since the headline (intraday) or since the open (pre-open), today so far, yesterday. */
  volume_since: number | null;
  day_volume: number | null;
  prev_day_volume: number | null;
  entry_submitted_at: string | null;
  entry_filled_at: string | null;
  exit_filled_at: string | null;
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
  // Columns added after the first release.
  await sql`ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'intraday',
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS summary text,
    ADD COLUMN IF NOT EXISTS news_count integer,
    ADD COLUMN IF NOT EXISTS prev_close double precision,
    ADD COLUMN IF NOT EXISTS open_price double precision,
    ADD COLUMN IF NOT EXISTS gap_pct double precision,
    ADD COLUMN IF NOT EXISTS range_high double precision,
    ADD COLUMN IF NOT EXISTS range_low double precision,
    ADD COLUMN IF NOT EXISTS range_volume double precision,
    ADD COLUMN IF NOT EXISTS volume_since double precision,
    ADD COLUMN IF NOT EXISTS day_volume double precision,
    ADD COLUMN IF NOT EXISTS prev_day_volume double precision,
    ADD COLUMN IF NOT EXISTS entry_submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS entry_filled_at timestamptz,
    ADD COLUMN IF NOT EXISTS exit_filled_at timestamptz`;
  await sql`CREATE TABLE IF NOT EXISTS misses (
    id serial PRIMARY KEY,
    day date NOT NULL,
    symbol text NOT NULL,
    detected_at timestamptz NOT NULL,
    day_change_pct double precision NOT NULL,
    price double precision,
    prev_close double precision,
    day_volume double precision,
    reason_code text NOT NULL,
    reason_text text NOT NULL,
    headline text,
    url text,
    news_at timestamptz,
    UNIQUE (day, symbol)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS worker_status (
    id integer PRIMARY KEY,
    updated_at timestamptz NOT NULL,
    info jsonb NOT NULL
  )`;
}

export type NewAlert = {
  kind: "intraday" | "preopen";
  symbol: string;
  direction: number;
  newsId: number;
  headline: string;
  summary: string;
  category: string;
  url: string;
  source: string;
  newsAt: string;
  newsCount: number;
  seenAt: Date;
  alertedAt: Date;
  baseline: number;
  price: number;
  movePct: number;
  prevClose: number | null;
  openPrice: number | null;
  gapPct: number | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  rangeVolume: number | null;
  volumeSince: number | null;
  dayVolume: number | null;
  prevDayVolume: number | null;
};

export async function insertAlert(a: NewAlert): Promise<number> {
  const rows = await db()`INSERT INTO alerts
    (kind, symbol, direction, news_id, headline, summary, category, url, source, news_at, news_count, seen_at, alerted_at,
     baseline, price, move_pct, prev_close, open_price, gap_pct, range_high, range_low, range_volume,
     volume_since, day_volume, prev_day_volume)
    VALUES (${a.kind}, ${a.symbol}, ${a.direction}, ${a.newsId}, ${a.headline}, ${a.summary}, ${a.category}, ${a.url},
            ${a.source}, ${a.newsAt}, ${a.newsCount}, ${a.seenAt.toISOString()}, ${a.alertedAt.toISOString()},
            ${a.baseline}, ${a.price}, ${a.movePct}, ${a.prevClose}, ${a.openPrice}, ${a.gapPct}, ${a.rangeHigh},
            ${a.rangeLow}, ${a.rangeVolume}, ${a.volumeSince}, ${a.dayVolume}, ${a.prevDayVolume})
    RETURNING id`;
  return rows[0].id as number;
}

export async function setTradeOpened(id: number, status: string, qty: number | null, orderId: string | null, submittedAt: string | null = null) {
  await db()`UPDATE alerts SET trade_status = ${status}, qty = ${qty}, entry_order_id = ${orderId},
    entry_submitted_at = ${submittedAt} WHERE id = ${id}`;
}

export async function setTradeStatus(id: number, status: string) {
  await db()`UPDATE alerts SET trade_status = ${status} WHERE id = ${id}`;
}

export async function setEntryFill(id: number, price: number, filledAt: string | null) {
  await db()`UPDATE alerts SET entry_price = ${price}, entry_filled_at = ${filledAt} WHERE id = ${id}`;
}

export async function setTradeClosed(id: number, exitOrderId: string | null, at: Date) {
  await db()`UPDATE alerts SET trade_status = 'closed', exit_order_id = ${exitOrderId}, exit_at = ${at.toISOString()} WHERE id = ${id}`;
}

export async function setExitFill(id: number, price: number, pnl: number, filledAt: string | null) {
  await db()`UPDATE alerts SET exit_price = ${price}, pnl = ${pnl}, exit_filled_at = ${filledAt} WHERE id = ${id}`;
}

export async function setResults(id: number, r: { price15m: number | null; price60m: number | null; close1d: number | null; done: boolean }) {
  await db()`UPDATE alerts SET price_15m = ${r.price15m}, price_60m = ${r.price60m}, close_1d = ${r.close1d},
    results_done = ${r.done} WHERE id = ${id}`;
}

/** Alerts the worker still has to follow up on: open trades, missing fills, missing results. */
export async function pendingAlerts(): Promise<AlertRow[]> {
  return rowsOut<AlertRow>(await db()`SELECT * FROM alerts
    WHERE NOT results_done OR trade_status = 'open'
       OR (entry_order_id IS NOT NULL AND entry_price IS NULL AND trade_status NOT LIKE 'error%')
       OR (exit_order_id IS NOT NULL AND exit_price IS NULL AND trade_status NOT LIKE 'error%')
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

export type MissRow = {
  id: number;
  day: string;
  symbol: string;
  detected_at: string;
  day_change_pct: number;
  price: number | null;
  prev_close: number | null;
  day_volume: number | null;
  reason_code: string;
  reason_text: string;
  headline: string | null;
  url: string | null;
  news_at: string | null;
};

/** Record a missed move, or update it with a bigger move later in the day (the reason stays as first found). */
export async function upsertMiss(m: {
  day: string;
  symbol: string;
  dayChangePct: number;
  price: number;
  prevClose: number | null;
  dayVolume: number | null;
  reasonCode: string;
  reasonText: string;
  headline: string | null;
  url: string | null;
  newsAt: string | null;
}) {
  await db()`INSERT INTO misses (day, symbol, detected_at, day_change_pct, price, prev_close, day_volume, reason_code, reason_text, headline, url, news_at)
    VALUES (${m.day}, ${m.symbol}, now(), ${m.dayChangePct}, ${m.price}, ${m.prevClose}, ${m.dayVolume}, ${m.reasonCode}, ${m.reasonText},
            ${m.headline}, ${m.url}, ${m.newsAt})
    ON CONFLICT (day, symbol) DO UPDATE SET
      day_change_pct = CASE WHEN abs(EXCLUDED.day_change_pct) > abs(misses.day_change_pct) THEN EXCLUDED.day_change_pct ELSE misses.day_change_pct END,
      price = CASE WHEN abs(EXCLUDED.day_change_pct) > abs(misses.day_change_pct) THEN EXCLUDED.price ELSE misses.price END,
      day_volume = EXCLUDED.day_volume`;
}

export async function recentMisses(days = 30): Promise<MissRow[]> {
  return rowsOut<MissRow>(await db()`SELECT id, to_char(day, 'YYYY-MM-DD') AS day, symbol, detected_at, day_change_pct, price, prev_close,
      day_volume, reason_code, reason_text, headline, url, news_at
    FROM misses WHERE day > (now() AT TIME ZONE 'America/New_York')::date - ${days}
    ORDER BY day DESC, abs(day_change_pct) DESC LIMIT 1000`);
}

/** Symbols alerted today (New York date), so they aren't counted as misses. */
export async function alertedOn(day: string): Promise<Set<string>> {
  const rows = await db()`SELECT DISTINCT symbol FROM alerts WHERE (alerted_at AT TIME ZONE 'America/New_York')::date = ${day}::date`;
  return new Set(rows.map((r) => r.symbol as string));
}

export async function writeStatus(info: Record<string, unknown>) {
  await db()`INSERT INTO worker_status (id, updated_at, info) VALUES (1, now(), ${JSON.stringify(info)})
    ON CONFLICT (id) DO UPDATE SET updated_at = now(), info = EXCLUDED.info`;
}

export async function readStatus(): Promise<{ updated_at: string; info: Record<string, unknown> } | null> {
  const rows = rowsOut<{ updated_at: string; info: Record<string, unknown> }>(await db()`SELECT updated_at, info FROM worker_status WHERE id = 1`);
  return rows[0] ?? null;
}
