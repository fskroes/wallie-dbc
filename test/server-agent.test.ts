import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import BN from "bn.js";
import { createLiveAgent, topUp, allowanceRemaining } from "allowance-kit";
import { DEFAULT_SPEC, buildEquityConfig } from "../config/equity-curve.ts";
import { configFromParameters, freshPool, applyTrade, toUnits } from "../src/simulate.ts";
import { buildReport } from "../src/report.ts";
import { startReportServer } from "../src/server.ts";
import { evaluate, watchLaunch, DEFAULT_RULES, fmtUsd } from "../src/agent.ts";
import type { LiveReport } from "../src/reader.ts";

/** A throwaway 64-byte Solana secret, JSON-array form. Never funded: the open is offline. */
function solanaKeyJson(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return JSON.stringify(Array.from(Buffer.concat([seed, pub])));
}

const T0 = 1_800_000_000;

/** An offline "chain": one simulated pool that advances one trade per report call. */
function offlineChain(trades: Array<{ side: "buy" | "sell"; amount: number }>) {
  const config = configFromParameters(buildEquityConfig(DEFAULT_SPEC));
  const pool = freshPool(config, new BN(T0));
  let holder = new BN(0);
  let i = 0;
  const reportFn = async (o: { pool: string; holder?: string; referenceBuyQuote?: number }): Promise<LiveReport> => {
    const t = trades[i++];
    if (t) {
      const q = applyTrade(pool, config, t.side, t.side === "buy" ? toUnits(t.amount, 6) : toUnits(t.amount, 6), new BN(T0 + i * 3600));
      if (t.side === "buy") holder = holder.add(q.outputAmount);
      else holder = holder.sub(q.excludedFeeInputAmount);
    }
    const report = buildReport({ pool, config, currentPoint: new BN(T0 + i * 3600), holderBase: o.holder ? holder : new BN(0), referenceBuyQuote: toUnits(o.referenceBuyQuote ?? 100, 6) });
    return { pool: o.pool, baseMint: "base", quoteMint: "quote", config: "cfg", creator: "creator", holder: o.holder, currentPoint: T0 + i * 3600, activationType: 1, report, fetchedAt: new Date().toISOString() };
  };
  return { reportFn, config, pool };
}

async function buyer(usd: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-dbc-"));
  const rt = await createLiveAgent({
    stateDir: dir,
    privateKey: solanaKeyJson(),
    network: "solana-devnet",
    rpcUrl: "http://127.0.0.1:1",
    checkOnChainBalance: false,
    preferScheme: "upto",
  });
  topUp(rt, usd);
  return rt;
}

test("agent buys reports within its allowance; each report costs $0.01 of a $0.10 ceiling and the rest refunds", async () => {
  const chain = offlineChain([{ side: "buy", amount: 5000 }, { side: "buy", amount: 5000 }, { side: "buy", amount: 5000 }]);
  const server = await startReportServer({ reportFn: chain.reportFn });
  const rt = await buyer(1);
  try {
    const before = allowanceRemaining(rt);
    const res = await watchLaunch({ ctx: rt.ctx, serverUrl: server.url, pool: "P", holder: "H", polls: 3 });
    assert.equal(res.polls.length, 3);
    for (const p of res.polls) {
      assert.equal(p.paid.ok, true, p.paid.error ?? p.paid.blockedBy?.detail ?? "");
      assert.equal(p.paid.costMicro, 10_000n);
      assert.equal(p.paid.quotedMicro, 100_000n);
      assert.equal(p.paid.refundMicro, 90_000n);
      assert.ok(p.report);
    }
    assert.equal(res.spentMicro, 30_000n);
    assert.equal(server.served, 3);
    assert.equal(before - allowanceRemaining(rt), 30_000n);
    assert.equal(fmtUsd(res.spentMicro), "$0.03");
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("a failed report charges nothing", async () => {
  const server = await startReportServer({
    reportFn: async () => {
      throw new Error("rpc down");
    },
  });
  const rt = await buyer(1);
  try {
    const res = await watchLaunch({ ctx: rt.ctx, serverUrl: server.url, pool: "P", polls: 1 });
    assert.equal(res.polls[0].paid.status, 502);
    assert.equal(res.polls[0].paid.costMicro, 0n);
    assert.equal(res.spentMicro, 0n);
    assert.equal(server.served, 0);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("the allowance caps the spend: the agent stops when the ceiling no longer fits", async () => {
  const chain = offlineChain([]);
  const server = await startReportServer({ reportFn: chain.reportFn });
  // Each request escrows the $0.10 ceiling, settles $0.01 and releases the rest.
  // $0.115 → poll 1 fits (0.115), poll 2 fits (0.105), poll 3 does not (0.095 < 0.10).
  const rt = await buyer(0.115);
  try {
    const res = await watchLaunch({ ctx: rt.ctx, serverUrl: server.url, pool: "P", polls: 10 });
    const ok = res.polls.filter((p) => p.paid.ok).length;
    assert.equal(ok, 2, JSON.stringify(res.polls.map((p) => [p.paid.ok, p.paid.blockedBy?.rule])));
    assert.match(res.stoppedBy ?? "", /^policy/);
    assert.equal(res.spentMicro, 20_000n);
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
});

test("alerts: stalled raise, lock-heavy, fee spike, exit haircut, completion", async () => {
  // Three polls with no trades: progress stays flat → stalled on the third.
  const chain = offlineChain([{ side: "buy", amount: 1000 }]);
  const server = await startReportServer({ reportFn: chain.reportFn });
  const rt = await buyer(1);
  try {
    const res = await watchLaunch({ ctx: rt.ctx, serverUrl: server.url, pool: "P", holder: "H", polls: 4, rules: { stalledPolls: 2 } });
    const rules = res.polls.map((p) => p.alerts.map((a) => a.rule));
    // opening fee 300 bps > 200 → fee-spike on early polls; 30% locked vs tiny sold → lock-heavy
    assert.ok(rules[0].includes("fee-spike"), JSON.stringify(rules));
    assert.ok(rules[0].includes("lock-heavy"));
    assert.ok(!rules[1].includes("stalled"));
    assert.ok(rules[2].includes("stalled") || rules[3].includes("stalled"), JSON.stringify(rules));
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }

  // Pure evaluate checks
  const base = (await chain.reportFn({ pool: "P", holder: "H" })).report;
  const haircut = { ...base, holderTokens: 100, exitHaircut: 0.5, exitNote: undefined };
  assert.ok(evaluate(haircut, undefined, 0, DEFAULT_RULES).some((a) => a.rule === "exit-haircut"));
  const complete = { ...base, phase: "complete" as const };
  assert.ok(evaluate(complete, undefined, 0, DEFAULT_RULES).some((a) => a.rule === "complete"));
  const migrated = { ...base, phase: "migrated" as const };
  assert.ok(evaluate(migrated, undefined, 0, DEFAULT_RULES).some((a) => a.rule === "migrated"));
});

test("health is free and describes the price", async () => {
  const server = await startReportServer({ reportFn: async () => { throw new Error("unused"); } });
  try {
    const h = (await fetch(`${server.url}/health`).then((r) => r.json())) as { ok: boolean; perReportMicro: string };
    assert.equal(h.ok, true);
    assert.equal(h.perReportMicro, "10000");
    const r = await fetch(`${server.url}/report?pool=x`);
    assert.equal(r.status, 402);
  } finally {
    await server.close();
  }
});
