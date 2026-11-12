import { test } from "node:test";
import assert from "node:assert/strict";
import { likelyMarketHours, openProblems } from "./health.ts";

const now = Date.parse("2026-11-12T20:50:00Z"); // Thu 3:50 PM ET
const base = { now, marketOpen: true, authFailingSince: null, streamDownSince: null, lastNewsAt: now - 60_000, openedAt: now - 6 * 3_600_000 };

test("healthy monitor has no problems", () => {
  assert.deepEqual(openProblems(base), []);
});

test("rejected keys are a problem after 5 minutes, even with the market closed", () => {
  assert.deepEqual(openProblems({ ...base, authFailingSince: now - 2 * 60_000 }), []);
  const p = openProblems({ ...base, marketOpen: false, authFailingSince: now - 10 * 60_000 });
  assert.deepEqual(p.map((x) => x.code), ["alpaca_keys"]);
});

test("stream down and news silence count only in market hours", () => {
  const down = { ...base, streamDownSince: now - 20 * 60_000, lastNewsAt: now - 40 * 60_000 };
  assert.deepEqual(openProblems(down).map((x) => x.code), ["news_stream", "no_news"]);
  assert.deepEqual(openProblems({ ...down, marketOpen: false }), []);
  // Just after the open, silence is measured from the open.
  assert.deepEqual(openProblems({ ...base, lastNewsAt: null, openedAt: now - 10 * 60_000 }), []);
});

test("market-hours guess", () => {
  assert.equal(likelyMarketHours(now), true);
  assert.equal(likelyMarketHours(Date.parse("2026-11-12T22:00:00Z")), false, "5 PM");
  assert.equal(likelyMarketHours(Date.parse("2026-11-14T16:00:00Z")), false, "Saturday");
});
