import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderReport, type DownsideReport } from "../src/report.ts";
import type { LiveReport } from "../src/reader.ts";

/**
 * docs/mainnet-report-2026-09-20.json is the pinned output of
 *   node dist/src/cli.js report <pool> --network solana --json
 * against two real mainnet-beta pools. This test keeps that record honest:
 * the addresses are real base58, the phases match the numbers, and the
 * formatter still prints the figures the README quotes. Offline.
 */
const record = JSON.parse(fs.readFileSync(new URL("../docs/mainnet-report-2026-09-20.json", import.meta.url), "utf8")) as {
  network: string; cluster: string; program: string; commit: string; capturedAt: string; pools: LiveReport[];
};
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

test("mainnet record targets the real program on mainnet-beta", () => {
  assert.equal(record.network, "solana");
  assert.equal(record.cluster, "mainnet-beta");
  assert.equal(record.program, "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
  assert.match(record.commit, /^[0-9a-f]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(record.capturedAt)));
  assert.equal(record.pools.length, 2);
});

test("each pool has real addresses and a self-consistent report", () => {
  for (const p of record.pools) {
    for (const k of ["pool", "baseMint", "quoteMint", "config", "creator"] as const) assert.match(p[k], B58, k);
    assert.ok(!Number.isNaN(Date.parse(p.fetchedAt)));
    const r: DownsideReport = p.report;
    assert.ok(["trading", "migrated", "complete"].includes(r.phase), r.phase);
    assert.ok(r.raisedQuote >= 0 && r.raiseTargetQuote > 0);
    assert.ok(Math.abs(r.raisedQuote + r.shortfallQuote - r.raiseTargetQuote) < 1e-6, "raised + shortfall = target");
    assert.ok(Math.abs(r.progress - r.raisedQuote / r.raiseTargetQuote) < 1e-9, "progress = raised / target");
    if (r.phase === "migrated") {
      assert.equal(r.shortfallQuote, 0);
      assert.equal(r.buysToGraduate, 0);
      assert.ok(Math.abs(r.priceNow - r.priceAtGraduation) < 1e-12, "migrated pools sit at the graduation price");
    } else {
      assert.ok(r.shortfallQuote > 0 && r.buysToGraduate >= 1);
      assert.ok(r.priceNow < r.priceAtGraduation);
    }
    assert.equal(r.holderTokens, 0, "market-only report");
    assert.equal(r.exitNote, "no position");
  }
});

test("the trading pool renders the lines the README quotes", () => {
  const trading = record.pools.find((p) => p.report.phase === "trading")!;
  assert.equal(trading.pool, "JEK34huFirCquM1UryNcE8DBdBEX1BGa9LtdZu1NhT5s");
  assert.equal(trading.quoteMint, "So11111111111111111111111111111111111111112");
  const text = renderReport(trading.report, "SOL");
  assert.match(text, /^phase {14}trading$/m);
  assert.match(text, /^raised {13}0\.096 SOL of 85 SOL {2}\(0\.1%\)$/m);
  assert.match(text, /^shortfall {10}84\.9 SOL {2}= 1 reference buys$/m);
  assert.match(text, /^sell fee now {7}400 bps {2}\(rests at 400 bps\)$/m);
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const line of text.split("\n")) assert.ok(readme.includes(line), `README quotes: ${line}`);
});

test("the migrated pool renders as fully raised", () => {
  const migrated = record.pools.find((p) => p.report.phase === "migrated")!;
  assert.equal(migrated.pool, "JEKDS3mbrwcrqHzUtKmeC7G4b3sx6khdkfZUvxhdgMFx");
  const text = renderReport(migrated.report, "SOL");
  assert.match(text, /^raised {13}200 SOL of 200 SOL {2}\(100\.0%\)$/m);
  assert.match(text, /^shortfall {10}0 SOL {2}= 0 reference buys$/m);
});
