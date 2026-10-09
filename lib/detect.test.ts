import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, rejectReason, rideReturn, symbolsToWatch, type NewsItem, type Watch } from "./detect.ts";
import { nextDayClose, priceAfter, resultsDone } from "./results.ts";
import { alertSubject } from "./email.ts";

const now = Date.parse("2026-10-08T17:00:00Z");
const news = (symbols: string[], minutesAgo = 1): NewsItem => ({
  id: 1,
  headline: "SpaceX buys 800 MHz spectrum",
  summary: "",
  url: "https://x",
  source: "benzinga",
  symbols,
  createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
});
const cfg = { movePct: 0.015, confirmTicks: 2, watchMinutes: 30, maxSymbolsPerHeadline: 4, minPrice: 3, minIexDollarVolume: 500_000 };

test("which headlines get watched", () => {
  assert.deepEqual(symbolsToWatch(news(["VZ", "t", "VZ"]), now, cfg), ["VZ", "T"]);
  assert.deepEqual(symbolsToWatch(news(["A", "B", "C", "D", "E"]), now, cfg), [], "roundups are skipped");
  assert.deepEqual(symbolsToWatch(news(["BTCUSD"]), now, cfg), [], "not a US ticker");
  assert.deepEqual(symbolsToWatch(news(["VZ"], 15), now, cfg), [], "stale news is skipped");
  assert.deepEqual(symbolsToWatch(news([]), now, cfg), []);
});

test("thin and cheap stocks are rejected", () => {
  assert.equal(rejectReason({ price: 2.5, tradeAt: now, prevDollarVolume: 9e6 }, cfg), "price under $3");
  assert.equal(rejectReason({ price: 40, tradeAt: now, prevDollarVolume: 1e5 }, cfg), "too thinly traded");
  assert.equal(rejectReason({ price: 40, tradeAt: now, prevDollarVolume: 9e6 }, cfg), null);
});

test("an alert needs the move to hold for two checks in the same direction", () => {
  const w: Watch = { symbol: "VZ", news: news(["VZ"]), seenAt: now, hits: 0, direction: 0 };
  const at = (price: number, sec: number) => evaluate(w, { price, tradeAt: now + sec * 1000, prevDollarVolume: 1e7 }, now + sec * 1000, cfg);
  assert.equal(at(46, 0), "wait"); // sets the baseline
  assert.equal(w.baseline, 46);
  assert.equal(at(45.2, 5), "wait"); // −1.7%, first hit
  assert.equal(at(46.9, 10), "wait"); // +2.0%, direction flipped: count restarts
  assert.equal(at(46.5, 15), "wait"); // +1.1%, below threshold: reset
  assert.equal(at(45.1, 20), "wait");
  assert.equal(at(45.0, 25), "alert");
  assert.equal(w.direction, -1);
});

test("stale trades are ignored and watches expire", () => {
  const w: Watch = { symbol: "VZ", news: news(["VZ"]), seenAt: now, hits: 0, direction: 0 };
  assert.equal(evaluate(w, { price: 46, tradeAt: now - 10 * 60_000, prevDollarVolume: 1e7 }, now, cfg), "wait");
  assert.equal(w.baseline, undefined, "no baseline from a stale trade");
  assert.equal(evaluate(w, { price: 46, tradeAt: now, prevDollarVolume: 1e7 }, now + 31 * 60_000, cfg), "expire");
});

test("ride return follows the alert's direction", () => {
  assert.ok(Math.abs(rideReturn(-1, 46, 43.7)! - 0.05) < 1e-9);
  assert.ok(Math.abs(rideReturn(1, 46, 43.7)! + 0.05) < 1e-9);
  assert.equal(rideReturn(1, null, 40), null);
});

test("results from bars", () => {
  const at = Date.parse("2026-10-08T17:00:00Z");
  const min = [0, 14, 15, 16, 60, 75].map((m) => ({ t: at + m * 60_000, c: 100 + m }));
  assert.equal(priceAfter(min, at, 15), 115);
  assert.equal(priceAfter(min, at, 60), 160);
  assert.equal(priceAfter(min, at, 30), null, "no bar within 10 minutes");
  const daily = ["2026-10-08T04:00:00Z", "2026-10-09T04:00:00Z"].map((d, i) => ({ t: Date.parse(d), c: 50 + i }));
  assert.equal(nextDayClose(daily, at), 51);
  // An alert at 9 PM ET on Oct 8 is still Oct 8 in New York.
  assert.equal(nextDayClose(daily, Date.parse("2026-10-09T01:00:00Z")), 51);
  assert.equal(resultsDone({ price60m: 1, close1d: null }, at, at + 86_400_000), false);
  assert.equal(resultsDone({ price60m: 1, close1d: null }, at, at + 6 * 86_400_000), true);
});

test("email subject", () => {
  const s = alertSubject({ symbol: "VZ", movePct: -0.021, minutesAfterNews: 6.2, baseline: 46, price: 45, headline: "SpaceX buys spectrum", summary: "", url: "", source: "", trade: "" });
  assert.equal(s, "VZ −2.1% · 6 min after: SpaceX buys spectrum");
});
