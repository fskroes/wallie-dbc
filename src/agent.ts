/**
 * The Wallie launch watcher. A buyer agent with an allowance that pays for
 * downside reports over x402 `upto` and raises alerts when a launch turns
 * against the holder. It never trades. It spends a capped amount on
 * information and stops when the cap is reached.
 *
 * Alert rules (all from the report, all explainable in one line):
 *   exit-haircut   exit value fell below `minExitOfMark` of mark
 *   stalled        progress did not move between polls for `stalledPolls` polls
 *   fee-spike      sell fee now is above `maxSellFeeBps`
 *   lock-heavy     locked supply above `maxLockedShare` of post-graduation supply
 *   complete       the curve completed: swaps closed until migration
 *   migrated       the pool migrated: sell on DAMM v2 now
 */
import { payingFetch, type PaidResult, type PayContext } from "allowance-kit";
import type { DownsideReport } from "./report.ts";
import type { LiveReport } from "./reader.ts";

export interface WatchRules {
  minExitOfMark: number;
  stalledPolls: number;
  maxSellFeeBps: number;
  maxLockedShare: number;
}

export const DEFAULT_RULES: WatchRules = {
  minExitOfMark: 0.9,
  stalledPolls: 3,
  maxSellFeeBps: 200,
  maxLockedShare: 0.5,
};

export interface Alert {
  rule: "exit-haircut" | "stalled" | "fee-spike" | "lock-heavy" | "complete" | "migrated";
  detail: string;
  at: string;
  report: DownsideReport;
}

export interface Poll {
  n: number;
  paid: PaidResult<LiveReport>;
  report?: DownsideReport;
  alerts: Alert[];
  spentMicro: bigint;
}

export interface WatchOptions {
  ctx: PayContext;
  serverUrl: string;
  pool: string;
  holder?: string;
  referenceBuyQuote?: number;
  polls: number;
  rules?: Partial<WatchRules>;
  /** Called after each poll. Return false to stop early. */
  onPoll?: (p: Poll) => void | boolean;
  /** Called between polls, after `onPoll`, with the poll number just finished. Awaited. */
  between?: (n: number) => void | Promise<void>;
  /** Sleep between polls, ms. Default 0 for tests. */
  intervalMs?: number;
}

export function evaluate(r: DownsideReport, prev: DownsideReport | undefined, stalledFor: number, rules: WatchRules, at = new Date().toISOString()): Alert[] {
  const out: Alert[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  if (r.phase === "migrated") out.push({ rule: "migrated", detail: "pool migrated; sell on the DAMM v2 pool", at, report: r });
  else if (r.phase === "complete") out.push({ rule: "complete", detail: "curve complete; swaps closed until migration", at, report: r });
  if (r.holderTokens > 0 && !r.exitNote && r.exitHaircut < rules.minExitOfMark) {
    out.push({ rule: "exit-haircut", detail: `exit now returns ${pct(r.exitHaircut)} of mark, below ${pct(rules.minExitOfMark)}`, at, report: r });
  }
  if (prev && r.phase === "trading" && stalledFor >= rules.stalledPolls) {
    out.push({ rule: "stalled", detail: `raise stuck at ${pct(r.progress)} for ${stalledFor} polls; ${r.buysToGraduate} reference buys still needed`, at, report: r });
  }
  if (r.sellFeeBpsNow > rules.maxSellFeeBps) {
    out.push({ rule: "fee-spike", detail: `sell fee is ${r.sellFeeBpsNow} bps, above ${rules.maxSellFeeBps} bps`, at, report: r });
  }
  if (r.lockedShareOfCirculating > rules.maxLockedShare) {
    out.push({ rule: "lock-heavy", detail: `${pct(r.lockedShareOfCirculating)} of post-graduation supply is locked, above ${pct(rules.maxLockedShare)}`, at, report: r });
  }
  return out;
}

export async function watchLaunch(o: WatchOptions): Promise<{ polls: Poll[]; spentMicro: bigint; stoppedBy?: string }> {
  const rules = { ...DEFAULT_RULES, ...o.rules };
  const polls: Poll[] = [];
  let spent = 0n;
  let prev: DownsideReport | undefined;
  let stalledFor = 0;
  let stoppedBy: string | undefined;
  const q = new URLSearchParams({ pool: o.pool });
  if (o.holder) q.set("holder", o.holder);
  if (o.referenceBuyQuote) q.set("ref", String(o.referenceBuyQuote));
  const url = `${o.serverUrl}/report?${q}`;

  for (let n = 1; n <= o.polls; n++) {
    const paid = (await payingFetch(o.ctx, url)) as PaidResult<LiveReport>;
    spent += paid.costMicro;
    let alerts: Alert[] = [];
    let report: DownsideReport | undefined;
    if (paid.ok && paid.body) {
      report = paid.body.report;
      if (prev && report.progress === prev.progress) stalledFor += 1;
      else stalledFor = 0;
      alerts = evaluate(report, prev, stalledFor, rules, paid.body.fetchedAt);
      prev = report;
    }
    const poll: Poll = { n, paid, report, alerts, spentMicro: spent };
    polls.push(poll);
    if (o.onPoll?.(poll) === false) {
      stoppedBy = "caller";
      break;
    }
    if (!paid.ok && paid.blockedBy) {
      stoppedBy = `policy: ${paid.blockedBy.rule} (${paid.blockedBy.detail})`;
      break;
    }
    if (report && (report.phase === "complete" || report.phase === "migrated")) {
      stoppedBy = report.phase;
      break;
    }
    if (n < o.polls) {
      await o.between?.(n);
      if (o.intervalMs) await new Promise((r) => setTimeout(r, o.intervalMs));
    }
  }
  return { polls, spentMicro: spent, stoppedBy };
}

export function fmtUsd(micro: bigint): string {
  const s = micro.toString().padStart(7, "0");
  return `$${s.slice(0, -6)}.${s.slice(-6, -4)}${s.slice(-4) === "0000" ? "" : s.slice(-4)}`;
}
