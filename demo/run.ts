/**
 * The demo, end to end, against the live surfnet launch:
 *
 *   1. start the paid report server (x402 upto, in-memory settlement, real chain reads)
 *   2. a Wallie agent with a $0.50 allowance polls the launch
 *   3. between polls, a second wallet buys on the real pool, so the figures move
 *   4. the agent prints the four downside figures and any alerts after every poll,
 *      and the money trail: escrowed, charged, refunded, allowance left
 *
 * Everything on chain is real (surfnet is a mainnet fork running the real DBC
 * program). Only the payment settlement is in-memory, exactly as the Wallie
 * MCP demo does it. Swap `pinnedOperator()` for `createSolanaUptoOperator`
 * and the same code settles USDC on devnet or mainnet.
 *
 *   node demo/run.ts [--launch launch.surfnet.json] [--polls 4] [--no-trades] [--out web/data.json]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { allowanceRemaining, createLiveAgent, topUp } from "allowance-kit";
import { startReportServer } from "../src/server.ts";
import { fmtUsd, watchLaunch, type Poll } from "../src/agent.ts";
import { renderReport } from "../src/report.ts";
import { fundOnSurfnet, loadLaunch, loadKey, trade } from "../scripts/trade.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const launch = loadLaunch(flag("launch") ?? "launch.surfnet.json");
const POLLS = Number(flag("polls") ?? 4);
const TRADES = !args.includes("--no-trades");
const OUT = flag("out");

function solanaKeyJson(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return JSON.stringify(Array.from(Buffer.concat([seed, pub])));
}

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(72));

async function main(): Promise<void> {
  rule();
  line(`  wallie-dbc demo  ${launch.spec.symbol} on ${launch.network}  pool ${launch.pool}`);
  rule();

  const trader = Keypair.generate();
  if (TRADES) {
    await fundOnSurfnet(launch.rpcUrl, trader.publicKey, 1, launch.quoteMint, 1_000_000);
    line(`  trader   ${trader.publicKey.toBase58()}  funded with 1,000,000 USDC on the fork`);
  }
  const holder = loadKey(".keys/creator.json").publicKey;

  const server = await startReportServer({ network: "solana-devnet", rpcUrl: launch.rpcUrl });
  line(`  server   ${server.url}  ${fmtUsd(server.perReportMicro)} per report, ${fmtUsd(server.ceilingMicro)} ceiling per call`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-dbc-demo-"));
  const rt = await createLiveAgent({
    stateDir: dir,
    privateKey: solanaKeyJson(),
    network: "solana-devnet",
    rpcUrl: "http://127.0.0.1:1",
    checkOnChainBalance: false,
    preferScheme: "upto",
  });
  topUp(rt, 0.5);
  line(`  agent    ${rt.address}  allowance ${fmtUsd(allowanceRemaining(rt))}`);
  line(`  holder   ${holder.toBase58()}  (the creator's first-buy position)`);

  const trades = [25_000, 150_000, 400_000];
  const tradeLog: Array<{ afterPoll: number; usd: number; sig: string }> = [];
  let i = 0;
  try {
    const res = await watchLaunch({
      ctx: rt.ctx,
      serverUrl: server.url,
      pool: launch.pool,
      holder: holder.toBase58(),
      referenceBuyQuote: 10_000,
      polls: POLLS,
      rules: { stalledPolls: 2 },
      onPoll: (p: Poll) => {
        line("");
        line(`  poll ${p.n}  ${p.paid.ok ? "paid" : "blocked"}  escrowed ${fmtUsd(p.paid.quotedMicro)} → charged ${fmtUsd(p.paid.costMicro)} → refunded ${fmtUsd(p.paid.refundMicro ?? 0n)}   allowance left ${fmtUsd(allowanceRemaining(rt))}`);
        if (p.report) for (const l of renderReport(p.report, "USDC", launch.spec.symbol).split("\n")) line(`    ${l}`);
        for (const a of p.alerts) line(`    ⚠ ${a.rule}: ${a.detail}`);
        if (!p.paid.ok) line(`    ${p.paid.blockedBy?.detail ?? p.paid.error}`);
        return undefined;
      },
      between: async (n: number) => {
        if (TRADES && i < trades.length) {
          const usd = trades[i++];
          try {
            const sig = await trade(launch, trader, "buy", usd);
            tradeLog.push({ afterPoll: n, usd, sig });
            line(`    → trader buys ${usd.toLocaleString("en-US")} USDC on the pool  ${sig.slice(0, 24)}…`);
          } catch (e) {
            line(`    → trade failed: ${(e as Error).message}`);
          }
        }
      },
    });
    line("");
    rule();
    line(`  ${res.polls.length} polls, spent ${fmtUsd(res.spentMicro)} of ${fmtUsd(500_000n)}${res.stoppedBy ? `, stopped by ${res.stoppedBy}` : ""}`);
    line(`  every report cost ${fmtUsd(server.perReportMicro)}; every unused cent of the ${fmtUsd(server.ceilingMicro)} escrow came back`);
    rule();
    if (OUT) {
      const data = {
        generatedAt: new Date().toISOString(),
        launch,
        holder: holder.toBase58(),
        trader: trader.publicKey.toBase58(),
        perReportMicro: server.perReportMicro.toString(),
        ceilingMicro: server.ceilingMicro.toString(),
        polls: res.polls.map((p) => ({
          n: p.n,
          ok: p.paid.ok,
          quotedMicro: p.paid.quotedMicro.toString(),
          costMicro: p.paid.costMicro.toString(),
          refundMicro: (p.paid.refundMicro ?? 0n).toString(),
          channelId: p.paid.channelId,
          report: p.report,
          alerts: p.alerts.map((a) => ({ rule: a.rule, detail: a.detail, at: a.at })),
          spentMicro: p.spentMicro.toString(),
        })),
        trades: tradeLog,
        spentMicro: res.spentMicro.toString(),
        stoppedBy: res.stoppedBy,
      };
      fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
      line(`  wrote ${OUT}`);
    }
  } finally {
    rt.stopHeartbeat?.();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
