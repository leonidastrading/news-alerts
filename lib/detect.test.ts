import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  evaluateBreakout,
  moveThreshold,
  volumeRatio,
  isNotNews,
  openingRange,
  overAlertLimit,
  preOpenNews,
  rejectReason,
  rideReturn,
  exitPlan,
  tradeBlock,
  entryLimit,
  confirmChecks,
  symbolsToWatch,
  type GapWatch,
  type NewsItem,
  type Snapshot,
  type Watch,
} from "./detect.ts";
import { categorize } from "./category.ts";
import { nyToUtc } from "./time.ts";
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
const cfg = { movePct: 0.015, confirmTicks: 2, watchMinutes: 30, maxSymbolsPerHeadline: 4, minPrice: 3, minIexDollarVolume: 500_000, breakoutBuffer: 0.001 };
const snap = (price: number, at: number, extra: Partial<Snapshot> = {}): Snapshot => ({
  price,
  tradeAt: at,
  prevDollarVolume: 1e7,
  prevClose: null,
  dayVolume: null,
  prevVolume: null,
  prevRange: null,
  ...extra,
});

test("which headlines get watched", () => {
  assert.deepEqual(symbolsToWatch(news(["VZ", "t", "VZ"]), now, cfg), ["VZ", "T"]);
  assert.deepEqual(symbolsToWatch(news(["A", "B", "C", "D", "E"]), now, cfg), [], "roundups are skipped");
  assert.deepEqual(symbolsToWatch(news(["BTCUSD"]), now, cfg), [], "not a US ticker");
  assert.deepEqual(symbolsToWatch(news(["VZ"], 15), now, cfg), [], "stale news is skipped");
  assert.deepEqual(symbolsToWatch(news([]), now, cfg), []);
});

test("thin and cheap stocks are rejected", () => {
  assert.equal(rejectReason(snap(2.5, now), cfg), "price under $3");
  assert.equal(rejectReason(snap(40, now, { prevDollarVolume: 1e5 }), cfg), "too thinly traded");
  assert.equal(rejectReason(snap(40, now), cfg), null);
});

test("an alert needs the move to hold for two checks in the same direction", () => {
  const w: Watch = { symbol: "VZ", news: news(["VZ"]), seenAt: now, hits: 0, direction: 0 };
  const at = (price: number, sec: number) => evaluate(w, snap(price, now + sec * 1000), now + sec * 1000, cfg);
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
  assert.equal(evaluate(w, snap(46, now - 10 * 60_000), now, cfg), "wait");
  assert.equal(w.baseline, undefined, "no baseline from a stale trade");
  assert.equal(evaluate(w, snap(46, now), now + 31 * 60_000, cfg), "expire");
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

test("email subjects", () => {
  const base = {
    kind: "intraday" as const,
    symbol: "VZ",
    direction: -1,
    newsId: 1,
    headline: "SpaceX buys spectrum",
    summary: "",
    category: "M&A",
    origin: "Other",
    url: "",
    source: "",
    newsAt: "2026-10-08T22:30:00Z",
    newsCount: 1,
    seenAt: new Date(),
    alertedAt: new Date(),
    baseline: 46,
    price: 45,
    movePct: -0.021,
    prevClose: 46.35,
    openPrice: null,
    gapPct: null,
    rangeHigh: null,
    rangeLow: null,
    rangeVolume: null,
    volumeSince: null,
    dayVolume: null,
    prevDayVolume: null,
    sp500: null,
    minutesAfterNews: 6.2,
    trade: "",
  };
  assert.equal(alertSubject(base), "VZ −2.1% · 6 min after: SpaceX buys spectrum");
  assert.equal(
    alertSubject({ ...base, kind: "preopen", gapPct: -0.06 }),
    "VZ broke below its opening range after a −6.0% gap: SpaceX buys spectrum",
  );
});

test("paper trades are held to the close by default", () => {
  const opened = Date.parse("2026-10-08T14:00:00Z"); // 10:00 ET
  const close = Date.parse("2026-10-08T20:00:00Z"); // 4:00 PM ET
  const plan = (iso: string, closeAt = close, hold = 0) => exitPlan(opened, Date.parse(iso), closeAt, hold, 12);
  assert.equal(plan("2026-10-08T19:30:00Z"), "wait", "3:30 PM: still holding");
  assert.equal(plan("2026-10-08T19:48:00Z"), "moc", "3:48 PM: market-on-close order");
  assert.equal(plan("2026-10-08T19:58:30Z"), "now", "3:58:30 PM: too late for market-on-close");
  assert.equal(plan("2026-10-08T14:31:00Z", close, 30), "now", "fixed 30-minute hold");
  // Missed the close (monitor was down): close at the next open.
  assert.equal(plan("2026-10-09T13:31:00Z", Date.parse("2026-10-09T20:00:00Z")), "now");
});

test("news from while the market was closed, grouped by ticker", () => {
  const items = [
    { ...news(["VZ", "T"]), id: 1, createdAt: "2026-10-08T22:30:00Z" },
    { ...news(["VZ"]), id: 2, createdAt: "2026-10-09T11:00:00Z", headline: "Verizon responds" },
    { ...news(["A", "B", "C", "D", "E"]), id: 3 },
  ];
  const m = preOpenNews(items, cfg);
  assert.deepEqual([...m.keys()].sort(), ["T", "VZ"]);
  assert.equal(m.get("VZ")!.count, 2);
  assert.equal(m.get("VZ")!.news.headline, "Verizon responds", "keeps the latest headline");
});

test("opening range and breakouts", () => {
  const r = openingRange([
    { o: 43.6, h: 44.1, l: 43.2, v: 1000 },
    { o: 43.9, h: 44.3, l: 43.5, v: 800 },
  ])!;
  assert.deepEqual(r, { open: 43.6, high: 44.3, low: 43.2, volume: 1800 });
  assert.equal(openingRange([]), null);

  const g: GapWatch = { symbol: "VZ", news: news(["VZ"]), newsCount: 1, seenAt: now, hits: 0, direction: 0, rangeHigh: 44.3, rangeLow: 43.2 };
  const end = now + 55 * 60_000;
  const at = (price: number, sec: number) => evaluateBreakout(g, snap(price, now + sec * 1000), now + sec * 1000, end, cfg);
  assert.equal(at(44.32, 0), "wait", "inside the 0.1% buffer");
  assert.equal(at(43.1, 5), "wait"); // below the range: first hit down
  assert.equal(at(43.0, 10), "alert");
  assert.equal(g.direction, -1);
  assert.equal(evaluateBreakout(g, snap(45, end + 1000), end + 1000, end, cfg), "expire");
  const unset: GapWatch = { ...g, rangeHigh: undefined, rangeLow: undefined, hits: 0, direction: 0 };
  assert.equal(evaluateBreakout(unset, snap(99, now), now, end, cfg), "wait", "no range yet");
});

test("news categories", () => {
  assert.equal(categorize("Verizon Q3 EPS $1.19 Beats $1.17 Estimate"), "Earnings");
  assert.equal(categorize("SpaceX to acquire 800 MHz spectrum from Grain Management"), "M&A");
  assert.equal(categorize("Morgan Stanley downgrades AT&T to Equal-Weight, lowers price target"), "Analyst rating");
  assert.equal(categorize("FDA approves Acme's drug for migraine"), "FDA / clinical");
  assert.equal(categorize("Acme announces $50M registered direct offering"), "Offering / financing");
  assert.equal(categorize("Shares are trading higher", "The company said its CEO will step down"), "Management");
  assert.equal(categorize("Stocks to watch this morning"), "Other");
});

test("New York wall-clock times to UTC", () => {
  assert.equal(new Date(nyToUtc("2026-10-09", "09:30")).toISOString(), "2026-10-09T13:30:00.000Z"); // EDT
  assert.equal(new Date(nyToUtc("2026-12-09", "09:30")).toISOString(), "2026-12-09T14:30:00.000Z"); // EST
  assert.equal(new Date(nyToUtc("2026-11-27", "13:00")).toISOString(), "2026-11-27T18:00:00.000Z"); // half day
});

test("a stock already outside its range when first seen must come back inside before a break counts", () => {
  const g: GapWatch = { symbol: "TROX", news: news(["TROX"]), newsCount: 1, seenAt: now, hits: 0, direction: 0, rangeHigh: 10, rangeLow: 9 };
  const end = now + 55 * 60_000;
  const at = (price: number, sec: number) => evaluateBreakout(g, snap(price, now + sec * 1000), now + sec * 1000, end, cfg);
  assert.equal(at(8.5, 0), "wait", "outside on first look: not armed");
  assert.equal(at(8.4, 5), "wait");
  assert.equal(at(8.3, 10), "wait", "no alert however long it stays out");
  assert.equal(at(9.5, 15), "wait", "back inside: armed");
  assert.equal(at(8.9, 20), "wait");
  assert.equal(at(8.8, 25), "alert", "fresh break down");
});

test("non-news articles are not watched", () => {
  for (const h of [
    "Tronox Holdings Reports Q2 2026 Results: Full Earnings Call Transcript",
    "Full Transcript: PENN Entertainment Q2 2026 Earnings Call",
    "Transcript: Allstate Q2 2026 Earnings Conference Call",
    "Performance Comparison: Airbnb And Competitors In Hotels, Restaurants & Leisure Industry",
    "Here's How Much You Would Have Made Owning Nvidia Stock In The Last 10 Years",
  ]) {
    assert.ok(isNotNews(h), h);
    assert.deepEqual(symbolsToWatch({ ...news(["X"]), headline: h }, now, cfg), [], h);
  }
  assert.equal(isNotNews("SpaceX To Acquire 800 MHz Spectrum Portfolio"), false);
  assert.equal(isNotNews("Verizon Q3 EPS $1.19 Beats $1.17 Estimate"), false);
});

test("alert safety cap", () => {
  const caps = { maxAlertsPer5Min: 3, maxAlertsPerDay: 5 };
  assert.equal(overAlertLimit([], now, caps), null);
  assert.match(overAlertLimit([now - 1000, now - 2000, now - 3000], now, caps)!, /per 5 minutes/);
  assert.equal(overAlertLimit([now - 6 * 60_000, now - 7 * 60_000, now - 8 * 60_000], now, caps), null);
  assert.match(overAlertLimit([1, 2, 3, 4, 5], now, caps)!, /daily limit/);
});

test("reactive headlines don't start intraday watches", () => {
  const h = { ...news(["HUM"]), headline: "Humana Stock Hits 52-Week High After Medicare Ratings Boost" };
  assert.deepEqual(symbolsToWatch(h, now, { ...cfg, skipReactive: true }), []);
  assert.deepEqual(symbolsToWatch(h, now, { ...cfg, skipReactive: false }), ["HUM"]);
  assert.deepEqual(symbolsToWatch({ ...news(["HUM"]), headline: "Humana Raises 2026 Guidance" }, now, { ...cfg, skipReactive: true }), ["HUM"]);
});

test("volatile stocks need bigger moves", () => {
  const c = { movePct: 0.015, rangeFraction: 0.25 };
  assert.equal(moveThreshold({ prevRange: 0.02 }, c), 0.015, "calm stock: 1.5%");
  assert.ok(Math.abs(moveThreshold({ prevRange: 0.12 }, c) - 0.03) < 1e-12, "12% daily range: 3%");
  assert.equal(moveThreshold({ prevRange: null }, c), 0.015);
});

test("a move without a burst of volume is not an alert (PURR)", () => {
  // PURR: yesterday 815K IEX shares (~2.1K a minute); 34.9K in 11 minutes is ~1.5x pace.
  const c = { ...cfg, rangeFraction: 0.25, minVolumeRatio: 2 };
  const base = { prevVolume: 815_300, prevRange: 0.04 };
  const w: Watch = { symbol: "PURR", news: news(["PURR"]), seenAt: now, hits: 0, direction: 0 };
  const at = (price: number, min: number, dayVolume: number) =>
    evaluate(w, snap(price, now + min * 60_000, { ...base, dayVolume }), now + min * 60_000, c);
  assert.equal(at(11.16, 0, 66_800), "wait"); // baseline
  assert.equal(at(11.34, 11, 101_700), "wait"); // +1.6%, volume 1.5x pace
  assert.equal(at(11.35, 11.1, 101_800), "wait");
  assert.ok(Math.abs(volumeRatio(w, { dayVolume: 101_700, prevVolume: 815_300 }, now + 11 * 60_000)! - 1.51) < 0.01);

  // Same move on heavy volume alerts.
  const v: Watch = { symbol: "PURR", news: news(["PURR"]), seenAt: now, hits: 0, direction: 0 };
  const at2 = (price: number, min: number, dayVolume: number) =>
    evaluate(v, snap(price, now + min * 60_000, { ...base, dayVolume }), now + min * 60_000, c);
  at2(11.16, 0, 66_800);
  assert.equal(at2(11.34, 5, 120_000), "wait");
  assert.equal(at2(11.36, 5.1, 121_000), "alert");
});

test("a few hundred shares can't trigger an alert (CABO)", () => {
  // CABO: 921 IEX shares (~$10K) in the 3.5 minutes after the headline, on a stock that trades ~41K a day.
  const c = { ...cfg, rangeFraction: 0.25, minVolumeRatio: 2, minDollarsSinceNews: 50_000 };
  const base = { prevVolume: 41_500, prevRange: 0.05, prevDollarVolume: 637_000 };
  const w: Watch = { symbol: "CABO", news: news(["CABO"]), seenAt: now, hits: 0, direction: 0 };
  const at = (price: number, min: number, dayVolume: number) =>
    evaluate(w, snap(price, now + min * 60_000, { ...base, dayVolume }), now + min * 60_000, c);
  at(11.51, 0, 38_500);
  assert.equal(at(10.6, 3.4, 39_300), "wait");
  assert.equal(at(10.53, 3.5, 39_421), "wait");
  assert.equal(w.hits, 0);
});

test("thin stocks need the move to hold for 30 seconds", () => {
  const c = { confirmTicks: 2, thinDollarVolume: 5e6, thinConfirmSeconds: 30, pollSeconds: 5 };
  assert.equal(confirmChecks({ prevDollarVolume: 637_000 }, c), 6);
  assert.equal(confirmChecks({ prevDollarVolume: 8e6 }, c), 2);
  assert.equal(confirmChecks({ prevDollarVolume: 637_000 }, { confirmTicks: 2 }), 2);
});

test("when an alert isn't traded", () => {
  const close = Date.parse("2026-10-09T20:00:00Z");
  const c = { tradeCutoffMinutes: 15, maxDayMoveToTrade: 0.15 };
  const ok = { kind: "intraday", baseline: 37.91, prevClose: 34.17 };
  assert.equal(tradeBlock(ok, Date.parse("2026-10-09T19:34:00Z"), close, c), null, "3:34 PM, +11% on the day");
  assert.match(tradeBlock(ok, Date.parse("2026-10-09T19:46:00Z"), close, c)!, /cutoff/);
  assert.equal(tradeBlock({ kind: "intraday", baseline: 11.51, prevClose: 15.36 }, Date.parse("2026-10-09T17:44:00Z"), close, c), "already −25% on the day");
  assert.equal(tradeBlock({ kind: "preopen", baseline: 11.51, prevClose: 15.36 }, Date.parse("2026-10-09T14:00:00Z"), close, c), null, "gaps are what opening-range breaks trade");
});

test("entry limit prices", () => {
  assert.equal(entryLimit(10.53, -1, 0.005), 10.48, "short: no lower than 0.5% under the alert price");
  assert.equal(entryLimit(77.17, 1, 0.005), 77.55, "long: no higher than 0.5% over");
});
