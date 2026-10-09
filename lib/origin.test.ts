import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrigin } from "./origin.ts";

const o = (headline: string, extra: { author?: string; summary?: string } = {}) => classifyOrigin({ headline, ...extra });

test("news origin from the headline and author", () => {
  assert.equal(o("Why Is AST SpaceMobile Stock Trading Lower Today?"), "Reactive (after the move)");
  assert.equal(o("Verizon, AT&T Shares Are Trading Lower After SpaceX Spectrum Deal"), "Reactive (after the move)");
  assert.equal(o("T, TMUS, VZ Stocks Plunge After-Hours As SpaceX Buys 800 MHz Spectrum"), "Reactive (after the move)");
  assert.equal(o("12 Communication Services Stocks Moving In Thursday's After-Hours Session"), "Reactive (after the move)");
  assert.equal(o("Humana Stock Hits 52-Week High After Medicare Ratings Boost"), "Reactive (after the move)");
  assert.equal(o("Humana Soars 16% on Improved Medicare Advantage Star Ratings"), "Reactive (after the move)");
  assert.equal(o("Alignment Healthcare Sinks 20% as Medicare Plan Downgraded"), "Reactive (after the move)");
  assert.equal(o("Starbucks Weighing Bid For Chipotle, Bloomberg Reports"), "Citing another outlet");
  assert.equal(o("SpaceX In Talks To Buy Spectrum, According To People Familiar"), "Citing another outlet");
  assert.equal(o("Form 4: Director Buys 10,000 Shares Of Acme"), "SEC filing");
  assert.equal(o("Acme Files 8-K Disclosing CFO Departure"), "SEC filing");
  assert.equal(o("Acme Q3 Results", { author: "Business Wire" }), "Press release");
  assert.equal(o("Verizon Q3 EPS $1.19 Beats $1.17 Estimate, Sales $33.8B"), "Earnings numbers");
  assert.equal(o("Morgan Stanley Downgrades AT&T To Equal-Weight, Lowers Price Target To $25"), "Analyst action");
  assert.equal(o("Acme Therapeutics Announces Positive Phase 3 Topline Results"), "Press release");
  assert.equal(o("SpaceX To Acquire 800 MHz Spectrum Portfolio From Grain Management"), "Other");
});
