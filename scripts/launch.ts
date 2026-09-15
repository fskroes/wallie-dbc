/**
 * Launch an equity spec on Meteora DBC. Two signed transactions:
 *
 *   1. partner  createConfig            the issuer's launch terms become a config account
 *   2. creator  createPoolWithFirstBuy  the base mint + virtual pool, plus an opening buy
 *
 * Networks:
 *   surfnet        mainnet fork at 402.surfnet.dev, airdrops and USDC minting allowed (default)
 *   solana-devnet  needs pre-funded keys in .keys/ (devnet airdrops are rate limited)
 *   solana         mainnet; the human gate. Refuses without --i-mean-mainnet.
 *
 * Usage:
 *   node scripts/launch.ts [spec.json] [--network surfnet] [--first-buy 5000] [--out launch.json]
 *
 * Keys live in .keys/{partner,creator}.json (solana-keygen format). Created if missing.
 * Output: launch.json with every address, so `report`/`scan` and the web page can find the pool.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DEFAULT_SPEC, USDC_MINT, buildEquityConfig, summarizeSpec, type EquityLaunchSpec } from "../config/equity-curve.ts";
import { RPC } from "../src/reader.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const specPath = args.find((a) => a.endsWith(".json") && !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const network = (flag("network") ?? "surfnet") as keyof typeof RPC;
const rpcUrl = flag("rpc") ?? RPC[network];
const outPath = flag("out") ?? `launch.${network}.json`;
const firstBuyUsd = Number(flag("first-buy") ?? 5000);

if (network === "solana" && !args.includes("--i-mean-mainnet")) {
  console.error("mainnet launch refused: pass --i-mean-mainnet and fund .keys/ first");
  process.exit(2);
}

function loadOrCreateKey(name: string): Keypair {
  mkdirSync(".keys", { recursive: true });
  const p = `.keys/${name}.json`;
  if (existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
  const k = Keypair.generate();
  writeFileSync(p, JSON.stringify(Array.from(k.secretKey)));
  return k;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function fund(conn: Connection, who: PublicKey, sol: number, usdcMint: string, usdc: number): Promise<void> {
  const bal = await conn.getBalance(who);
  if (bal < sol * 1e9) {
    if (network === "solana") throw new Error(`${who.toBase58()} needs ${sol} SOL on mainnet; fund it by hand`);
    const sig = (await rpc("requestAirdrop", [who.toBase58(), Math.round(sol * 1e9)])) as string;
    await conn.confirmTransaction(sig, "confirmed").catch(() => undefined);
  }
  if (usdc > 0 && network === "surfnet") {
    await rpc("surfnet_setTokenAccount", [who.toBase58(), usdcMint, { amount: Math.round(usdc * 1e6) }]);
  }
}

async function main(): Promise<void> {
  const spec: EquityLaunchSpec = specPath ? JSON.parse(readFileSync(specPath, "utf8")) : DEFAULT_SPEC;
  const sum = summarizeSpec(spec);
  const usdcMint = network === "solana-devnet" ? USDC_MINT["solana-devnet"] : USDC_MINT["solana"];
  const conn = new Connection(rpcUrl, "confirmed");
  const client = DynamicBondingCurveClient.create(conn, "confirmed");

  const partner = loadOrCreateKey("partner");
  const creator = loadOrCreateKey("creator");
  console.log(`network  ${network}  ${rpcUrl}`);
  console.log(`partner  ${partner.publicKey.toBase58()}`);
  console.log(`creator  ${creator.publicKey.toBase58()}`);
  console.log(`spec     ${spec.symbol}  open ${spec.openingPriceUsd}  list ${spec.listingPriceUsd}  raise ${sum.raiseTargetUsd.toLocaleString("en-US")} USDC`);

  await fund(conn, partner.publicKey, 1, usdcMint, 0);
  await fund(conn, creator.publicKey, 1, usdcMint, firstBuyUsd);

  // 1. config
  const params = buildEquityConfig(spec);
  const config = Keypair.generate();
  const tx1 = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
    quoteMint: new PublicKey(usdcMint),
    payer: partner.publicKey,
    ...params,
  });
  const sig1 = await sendAndConfirmTransaction(conn, tx1, [partner, config], { commitment: "confirmed" });
  console.log(`config   ${config.publicKey.toBase58()}  ${sig1}`);

  // 2. pool + first buy
  const baseMint = Keypair.generate();
  const pool = deriveDbcPoolAddress(new PublicKey(usdcMint), baseMint.publicKey, config.publicKey);
  const tx2 = await client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      name: spec.name,
      symbol: spec.symbol,
      uri: `https://onewallie.com/dbc/${spec.symbol.toLowerCase()}.json`,
      payer: creator.publicKey,
      poolCreator: creator.publicKey,
      config: config.publicKey,
      baseMint: baseMint.publicKey,
    },
    firstBuyParam:
      firstBuyUsd > 0
        ? { buyer: creator.publicKey, buyAmount: new BN(Math.round(firstBuyUsd * 1e6)), minimumAmountOut: new BN(1), referralTokenAccount: null }
        : undefined,
  });
  const sig2 = await sendAndConfirmTransaction(conn, tx2, [creator, baseMint], { commitment: "confirmed" });
  console.log(`baseMint ${baseMint.publicKey.toBase58()}`);
  console.log(`pool     ${pool.toBase58()}  ${sig2}`);

  const record = {
    network,
    rpcUrl,
    launchedAt: new Date().toISOString(),
    spec,
    summary: sum,
    partner: partner.publicKey.toBase58(),
    creator: creator.publicKey.toBase58(),
    quoteMint: usdcMint,
    config: config.publicKey.toBase58(),
    baseMint: baseMint.publicKey.toBase58(),
    pool: pool.toBase58(),
    tx: { createConfig: sig1, createPoolWithFirstBuy: sig2 },
    firstBuyUsd,
  };
  writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`wrote    ${outPath}`);
  console.log(`\nnext:    node src/cli.ts report ${pool.toBase58()} --holder ${creator.publicKey.toBase58()} --network ${network}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
