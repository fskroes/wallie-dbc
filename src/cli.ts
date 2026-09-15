#!/usr/bin/env node
/**
 * wallie-dbc CLI
 *
 *   report <pool> [--holder <wallet>] [--network solana|solana-devnet|surfnet] [--rpc <url>] [--ref <usd>] [--json]
 *   scan   <config> [--network ...] [--json]
 *   spec   [spec.json]                      print the DBC config an equity spec produces
 *   simulate [spec.json] [--steps steps.json] [--json]   replay trades offline, report after each
 *   sample [--network ...] [--count 10]     list recent pool addresses
 */
import { readFileSync } from "node:fs";
import { DEFAULT_SPEC, buildEquityConfig, summarizeSpec, type EquityLaunchSpec } from "../config/equity-curve.ts";
import { RPC, liveReport, samplePools, scanConfig } from "./reader.ts";
import { renderReport } from "./report.ts";
import { configFromParameters, simulate, type SimStep } from "./simulate.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));

function rpcUrl(): string {
  const net = (flag("network") ?? "solana") as keyof typeof RPC;
  return flag("rpc") ?? RPC[net] ?? RPC.solana;
}

function bnToString(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && "toString" in v && (v as { constructor?: { name?: string } }).constructor?.name === "BN") return (v as { toString(): string }).toString();
  if (v && typeof v === "object" && "toBase58" in v) return (v as { toBase58(): string }).toBase58();
  return v;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "report": {
      const pool = positional[0];
      if (!pool) throw new Error("usage: report <pool> [--holder <wallet>]");
      const r = await liveReport({ rpcUrl: rpcUrl(), pool, holder: flag("holder"), referenceBuyQuote: Number(flag("ref") ?? 100) });
      if (has("json")) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`pool ${r.pool}\nbase ${r.baseMint}\nquote ${r.quoteMint}${r.holder ? `\nholder ${r.holder}` : ""}\n`);
        console.log(renderReport(r.report, r.quoteMint.startsWith("So1111") ? "SOL" : "USDC", "TOKEN"));
      }
      return;
    }
    case "scan": {
      const cfg = positional[0];
      if (!cfg) throw new Error("usage: scan <config>");
      const rs = await scanConfig(rpcUrl(), cfg, Number(flag("ref") ?? 100));
      if (has("json")) console.log(JSON.stringify(rs, null, 2));
      else {
        console.log(`${rs.length} pool(s) on config ${cfg}\n`);
        for (const r of rs) console.log(`${r.pool}\n${renderReport(r.report)}\n`);
      }
      return;
    }
    case "spec": {
      const spec = positional[0] ? (JSON.parse(readFileSync(positional[0], "utf8")) as EquityLaunchSpec) : DEFAULT_SPEC;
      const sum = summarizeSpec(spec);
      const c = buildEquityConfig(spec);
      if (has("json")) console.log(JSON.stringify({ spec, summary: sum, config: c }, bnToString, 2));
      else {
        console.log(`${spec.symbol}  ${spec.name}`);
        console.log(`opening ${spec.openingPriceUsd} USDC  listing ${spec.listingPriceUsd} USDC  float ${spec.floatPercent}%  lock ${spec.insiderLockPercent}%`);
        console.log(`raise target ${sum.raiseTargetUsd.toLocaleString("en-US")} USDC over ${sum.curveSupply.toLocaleString("en-US")} curve shares (avg ${sum.averageCurvePriceUsd.toFixed(2)})`);
        console.log(`float ${sum.floatSupply.toLocaleString("en-US")}  locked ${sum.lockedSupply.toLocaleString("en-US")}  treasury ${sum.treasurySupply.toLocaleString("en-US")}`);
        console.log(`\nDBC config:`);
        console.log(JSON.stringify(c, bnToString, 2));
      }
      return;
    }
    case "simulate": {
      const spec = positional[0] ? (JSON.parse(readFileSync(positional[0], "utf8")) as EquityLaunchSpec) : DEFAULT_SPEC;
      const stepsFile = flag("steps");
      const t0 = 1_800_000_000;
      const steps: SimStep[] = stepsFile
        ? (JSON.parse(readFileSync(stepsFile, "utf8")) as SimStep[])
        : [
            { side: "buy", amount: 50_000, at: t0 + 60, who: "alice" },
            { side: "buy", amount: 200_000, at: t0 + 3600, who: "bob" },
            { side: "buy", amount: 500_000, at: t0 + 7200, who: "carol" },
            { side: "sell", amount: 3000, at: t0 + 7300, who: "alice" },
            { side: "buy", amount: 1_700_000, at: t0 + 90_000, who: "dan" },
          ];
      const watch = flag("watch") ?? steps[0]?.who ?? "alice";
      const cfg = configFromParameters(buildEquityConfig(spec));
      const res = simulate(cfg, steps, { activationPoint: Number(flag("activation") ?? t0), watch, referenceBuyQuote: Number(flag("ref") ?? 10_000) });
      if (has("json")) console.log(JSON.stringify(res, null, 2));
      else
        for (const r of res) {
          console.log(`\n== ${r.step.who} ${r.step.side} ${r.step.amount} @ +${r.step.at - t0}s${r.rejected ? `  REJECTED: ${r.rejected}` : ""}`);
          console.log(renderReport(r.report, "USDC", spec.symbol));
        }
      return;
    }
    case "sample": {
      const list = await samplePools(rpcUrl(), Number(flag("count") ?? 10));
      console.log(list.join("\n"));
      return;
    }
    default:
      console.log("usage: wallie-dbc <report|scan|spec|simulate|sample> ...");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
