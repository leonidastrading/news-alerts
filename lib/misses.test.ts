import { test } from "node:test";
import assert from "node:assert/strict";
import { missReason, type DayLog } from "./misses.ts";

const t0 = Date.parse("2026-10-09T14:00:00Z"); // 10:00 ET
const started = Date.parse("2026-10-09T12:00:00Z");
const h = (minutes: number, roundup = false) => ({ at: t0 + minutes * 60_000, headline: "Headline", url: "https://x", roundup });
const w = (o: Partial<DayLog["watches"][number]>) => ({
  kind: "intraday" as const,
  startedAt: t0,
  endedAt: t0 + 30 * 60_000,
  outcome: "expired",
  maxMove: 0.008,
  preMove: 0.004,
  ...o,
});
const code = (log: DayLog | undefined, startedAt = started) => missReason(log, startedAt, 0.015).code;

test("why a big mover had no alert", () => {
  assert.equal(code(undefined), "no_news");
  assert.equal(code({ headlines: [h(0, true)], watches: [] }), "roundup");
  assert.equal(code({ headlines: [h(-200)], watches: [] }, t0), "not_running");
  assert.equal(code({ headlines: [h(0)], watches: [w({ outcome: "filtered: too thinly traded" })] }), "filtered");
  assert.equal(code({ headlines: [h(0)], watches: [w({ outcome: "cooldown" })] }), "cooldown");
  assert.equal(code({ headlines: [h(0)], watches: [w({ preMove: -0.06 })] }), "before_headline");
  assert.equal(code({ headlines: [h(0)], watches: [w({})] }), "too_small");
  assert.equal(code({ headlines: [h(-60)], watches: [w({ kind: "preopen", preMove: 0.08 })] }), "preopen_no_break");
});

test("reason text says what happened", () => {
  const r = missReason({ headlines: [h(0)], watches: [w({ maxMove: -0.009 })] }, started, 0.015);
  assert.match(r.text, /moved at most −0\.9% \(needs 1\.5%\)/);
  const g = missReason({ headlines: [h(-60)], watches: [w({ kind: "preopen", preMove: 0.08 })] }, started, 0.015);
  assert.match(g.text, /after a \+8\.0% gap/);
});
