import { test } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { DEFAULT_SPEC, buildEquityConfig, summarizeSpec } from "../config/equity-curve.ts";
import { configFromParameters, freshPool, simulate, toUnits, applyTrade } from "../src/simulate.ts";
import { baseAhead, buildReport, poolPhase, renderReport } from "../src/report.ts";

const T0 = 1_800_000_000;
const cfg = () => configFromParameters(buildEquityConfig(DEFAULT_SPEC));

test("fresh pool: nothing raised, full shortfall, no position", () => {
  const c = cfg();
  const r = buildReport({ pool: freshPool(c, new BN(T0)), config: c, currentPoint: new BN(T0), holderBase: new BN(0), referenceBuyQuote: toUnits(10_000, 6) });
  assert.equal(r.phase, "trading");
  assert.equal(r.raisedQuote, 0);
  assert.equal(r.raiseTargetQuote, 2_400_000);
  assert.equal(r.shortfallQuote, 2_400_000);
  assert.equal(r.progress, 0);
  assert.equal(r.exitNote, "no position");
  assert.ok(Math.abs(r.priceNow - 8) < 0.01);
  assert.ok(Math.abs(r.priceAtGraduation - 12) < 0.01);
  assert.equal(r.lockedTokens, 300_000);
  assert.equal(r.soldTokens, 0);
  assert.ok(Math.abs(r.floatTokens - 200_000) < 1);
  // 10k buys at 300bps: net 9,700 each → 2.4M / 9.7k = 248 buys
  assert.equal(r.buysToGraduate, Math.ceil(2_400_000 / 9_700));
});

test("before activation the phase is pending and the fee is the cliff fee", () => {
  const c = cfg();
  const pool = freshPool(c, new BN(T0));
  const r = buildReport({ pool, config: c, currentPoint: new BN(T0 - 100), holderBase: new BN(0), referenceBuyQuote: toUnits(1000, 6) });
  assert.equal(r.phase, "pending");
  assert.equal(r.notYetOpen, true);
  assert.equal(r.sellFeeBpsNow, 300);
  assert.equal(poolPhase(pool, c, new BN(T0)), "trading");
});

test("a buyer's exit value is below mark by the sell fee and the curve walk-down", () => {
  const c = cfg();
  const [r] = simulate(c, [{ side: "buy", amount: 50_000, at: T0 + 60, who: "a" }], { activationPoint: T0, watch: "a", referenceBuyQuote: 10_000 });
  assert.equal(r.rejected, undefined);
  assert.ok(r.report.holderTokens > 6_000 && r.report.holderTokens < 6_100, String(r.report.holderTokens));
  assert.ok(r.report.exitValueNowQuote < r.report.holderMarkQuote);
  assert.ok(r.report.exitValueNowQuote < 50_000, "you never get back more than you put in");
  assert.ok(r.report.exitHaircut > 0.95 && r.report.exitHaircut < 1);
  assert.equal(r.report.sellFeeBpsNow, 300);
  assert.equal(r.report.exitFeeNowQuote > 0, true);
});

test("fee decays over the flip window and rests at the resting fee", () => {
  const c = cfg();
  const steps = [
    { side: "buy" as const, amount: 1000, at: T0 + 60, who: "a" },
    { side: "buy" as const, amount: 1000, at: T0 + 12 * 3600, who: "a" },
    { side: "buy" as const, amount: 1000, at: T0 + 25 * 3600, who: "a" },
  ];
  const res = simulate(c, steps, { activationPoint: T0, watch: "a", referenceBuyQuote: 1000 });
  assert.equal(res[0].report.sellFeeBpsNow, 300);
  assert.ok(res[1].report.sellFeeBpsNow < 300 && res[1].report.sellFeeBpsNow > 25);
  assert.equal(res[2].report.sellFeeBpsNow, 25);
  assert.equal(res[2].report.restingFeeBps, 25);
});

test("reserves and price move together; the raise is what the curve keeps after fees", () => {
  const c = cfg();
  const pool = freshPool(c, new BN(T0));
  const q = applyTrade(pool, c, "buy", toUnits(100_000, 6), new BN(T0 + 100_000));
  // fee rests at 25 bps after the window, fees are on input
  assert.equal(q.excludedFeeInputAmount.toString(), pool.poolState.quoteReserve.toString());
  assert.ok(pool.poolState.quoteReserve.lt(toUnits(100_000, 6)));
  assert.ok(pool.poolState.quoteReserve.gt(toUnits(99_000, 6)));
  assert.ok(pool.poolState.sqrtPrice.gt(c.sqrtStartPrice));
  // sold-so-far equals what the buyer received
  const ahead = baseAhead(pool.poolState.sqrtPrice, c);
  const sold = c.swapBaseAmount.sub(ahead);
  assert.ok(sold.sub(q.outputAmount).abs().lten(2), `sold ${sold} vs out ${q.outputAmount}`);
});

test("selling everything back returns less than paid; the pool never pays out more than it holds", () => {
  const c = cfg();
  const res = simulate(
    c,
    [
      { side: "buy", amount: 20_000, at: T0 + 10, who: "a" },
      { side: "sell", amount: 1e9, at: T0 + 20, who: "a" },
    ],
    { activationPoint: T0, watch: "a", referenceBuyQuote: 1000 },
  );
  assert.equal(res[1].rejected, undefined);
  assert.equal(res[1].balances.a, 0);
  assert.ok(res[1].report.raisedQuote >= 0);
  assert.ok(res[1].report.raisedQuote < 20_000 * 0.03 * 2, `residual ${res[1].report.raisedQuote}`);
});

test("the curve completes when the raise is met and further buys are rejected", () => {
  const c = cfg();
  const sum = summarizeSpec(DEFAULT_SPEC);
  const res = simulate(
    c,
    [
      { side: "buy", amount: sum.raiseTargetUsd * 1.01, at: T0 + 200_000, who: "whale" },
      { side: "buy", amount: 10, at: T0 + 200_001, who: "late" },
    ],
    { activationPoint: T0, watch: "whale", referenceBuyQuote: 1000 },
  );
  // One buy bigger than the curve holds is partially filled: the curve takes what it needs.
  assert.equal(res[0].rejected, undefined);
  assert.equal(res[0].report.phase, "complete");
  assert.ok(Math.abs(res[0].report.raisedQuote - sum.raiseTargetUsd) < 1, String(res[0].report.raisedQuote));
  assert.match(res[1].rejected ?? "", /completed/);
  // The same in slices. 12 × 200k gross is 2.394M net after the 25 bps fee, so 13 are needed.
  const slices = Array.from({ length: 13 }, (_, i) => ({ side: "buy" as const, amount: 200_000, at: T0 + 200_000 + i, who: "w" }));
  const res2 = simulate(c, [...slices, { side: "buy", amount: 10, at: T0 + 300_000, who: "late" }], { activationPoint: T0, watch: "w", referenceBuyQuote: 1000 });
  const last = res2[res2.length - 1];
  const done = res2.findIndex((r) => r.report.phase === "complete");
  assert.equal(done, 12, "curve should complete on the 13th slice");
  assert.equal(last.report.phase, "complete");
  assert.match(last.rejected ?? "", /completed/);
  assert.equal(last.report.shortfallQuote, 0);
  assert.equal(last.report.buysToGraduate, 0);
  assert.equal(last.report.exitNote, "curve complete; swaps are closed until migration");
  // the buyer at completion sold the whole curve supply
  assert.ok(Math.abs(res2[done].report.soldTokens - summarizeSpec(DEFAULT_SPEC).curveSupply) < 5, String(res2[done].report.soldTokens));
});

test("renderReport prints one line per figure", () => {
  const c = cfg();
  const [r] = simulate(c, [{ side: "buy", amount: 5000, at: T0 + 1, who: "a" }], { activationPoint: T0, watch: "a", referenceBuyQuote: 1000 });
  const text = renderReport(r.report, "USDC", "ACMEx");
  for (const k of ["phase", "price now", "raised", "shortfall", "position", "exit value now", "sell fee now", "locked supply"]) {
    assert.ok(text.includes(k), k);
  }
  assert.ok(text.includes("ACMEx"));
});
