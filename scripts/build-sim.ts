/**
 * Precompute the simulation the web page scrubs through. Pure, no chain.
 *
 * Scenario: "you" buy 10,000 USDC in the first minute. Then the book fills in
 * 40 buys spread over 48 hours, so the flip-window fee decays as the raise
 * grows. After every step the page can show what you would get back if you
 * sold right then, and how far the launch is from graduating.
 *
 *   node scripts/build-sim.ts [spec.json] [--out web/sim.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_SPEC, buildEquityConfig, summarizeSpec, type EquityLaunchSpec } from "../config/equity-curve.ts";
import { configFromParameters, simulate, type SimStep } from "../src/simulate.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const specPath = args.find((a) => a.endsWith(".json") && args[args.indexOf(a) - 1] !== "--out");
const spec: EquityLaunchSpec = specPath ? JSON.parse(readFileSync(specPath, "utf8")) : DEFAULT_SPEC;
const out = flag("out") ?? "web/sim.json";

const T0 = 1_800_000_000;
const sum = summarizeSpec(spec);
const YOU = 10_000;
const STEPS = 40;
const HOURS = 48;

// Fill the book. The total gross is a little above the raise because fees come off the top.
const gross = sum.raiseTargetUsd * 1.02;
const steps: SimStep[] = [{ side: "buy", amount: YOU, at: T0 + 60, who: "you" }];
for (let i = 1; i <= STEPS; i++) {
  // front-loaded: early buys are smaller, later ones larger, like a book that gains confidence
  const w = (i / STEPS) ** 1.3;
  const prevW = ((i - 1) / STEPS) ** 1.3;
  steps.push({ side: "buy", amount: Math.round((gross - YOU) * (w - prevW)), at: T0 + Math.round((i / STEPS) * HOURS * 3600), who: `buyer${i}` });
}

const cfg = configFromParameters(buildEquityConfig(spec));
const res = simulate(cfg, steps, { activationPoint: T0, watch: "you", referenceBuyQuote: 10_000 });

const frames = res.map((r) => ({
  hours: +((r.step.at - T0) / 3600).toFixed(2),
  who: r.step.who,
  buyUsd: r.step.amount,
  rejected: r.rejected ?? null,
  ...r.report,
}));

writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      spec,
      summary: sum,
      you: { paidUsd: YOU, tokens: frames[0].holderTokens },
      frames,
    },
    null,
    1,
  ),
);
console.log(`wrote ${out}: ${frames.length} frames, raise ${sum.raiseTargetUsd} USDC, you hold ${frames[0].holderTokens.toFixed(3)} ${spec.symbol} for ${YOU} USDC`);
console.log(`final: ${frames[frames.length - 1].phase} at ${(frames[frames.length - 1].progress * 100).toFixed(1)}%`);
