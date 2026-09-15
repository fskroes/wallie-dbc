/**
 * Trade against a launched pool. Used by the demo to move the market between
 * agent polls, and by hand to test a live launch.
 *
 *   node scripts/trade.ts buy  <usd>    [--launch launch.surfnet.json] [--key .keys/creator.json]
 *   node scripts/trade.ts sell <tokens> [--launch launch.surfnet.json] [--key .keys/creator.json]
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";

export interface LaunchRecord {
  network: string;
  rpcUrl: string;
  quoteMint: string;
  config: string;
  baseMint: string;
  pool: string;
  creator: string;
  spec: { symbol: string };
}

export function loadLaunch(path = "launch.surfnet.json"): LaunchRecord {
  return JSON.parse(readFileSync(path, "utf8")) as LaunchRecord;
}

export function loadKey(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export async function trade(
  launch: LaunchRecord,
  signer: Keypair,
  side: "buy" | "sell",
  amountWhole: number,
  opts: { rpcUrl?: string; quoteDecimals?: number; baseDecimals?: number } = {},
): Promise<string> {
  const conn = new Connection(opts.rpcUrl ?? launch.rpcUrl, "confirmed");
  const client = DynamicBondingCurveClient.create(conn, "confirmed");
  const dec = side === "buy" ? (opts.quoteDecimals ?? 6) : (opts.baseDecimals ?? 6);
  const tx = await client.pool.swap({
    owner: signer.publicKey,
    pool: new PublicKey(launch.pool),
    amountIn: new BN(Math.round(amountWhole * 10 ** dec)),
    minimumAmountOut: new BN(0),
    swapBaseForQuote: side === "sell",
    referralTokenAccount: null,
  });
  return sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
}

/** Give a wallet SOL and USDC on a surfnet fork. No-op elsewhere. */
export async function fundOnSurfnet(rpcUrl: string, who: PublicKey, sol: number, usdcMint: string, usdc: number): Promise<void> {
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
  };
  if (sol > 0) await call("requestAirdrop", [who.toBase58(), Math.round(sol * 1e9)]);
  if (usdc > 0) await call("surfnet_setTokenAccount", [who.toBase58(), usdcMint, { amount: Math.round(usdc * 1e6) }]);
}

const isMain = process.argv[1]?.endsWith("trade.ts") || process.argv[1]?.endsWith("trade.js");
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const side = args[0] as "buy" | "sell";
  const amount = Number(args[1]);
  if (!["buy", "sell"].includes(side) || !(amount > 0)) {
    console.error("usage: trade.ts buy|sell <amount> [--launch file] [--key file]");
    process.exit(1);
  }
  const launch = loadLaunch(flag("launch"));
  const signer = loadKey(flag("key") ?? ".keys/creator.json");
  trade(launch, signer, side, amount)
    .then((sig) => console.log(`${side} ${amount} ${side === "buy" ? "USDC" : launch.spec.symbol}  ${sig}`))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
