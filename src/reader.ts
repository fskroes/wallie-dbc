/**
 * Live chain reader. Fetches a DBC pool, its config, the current point and a
 * holder's balance, then hands them to the pure report. Works against any
 * network the program is deployed on: mainnet, devnet, or a surfnet fork.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  getCurrentPoint,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { buildReport, quoteDecimalsFor, type DownsideReport } from "./report.ts";

export const RPC = {
  "solana": "https://api.mainnet-beta.solana.com",
  "solana-devnet": "https://api.devnet.solana.com",
  "surfnet": "https://402.surfnet.dev:8899",
} as const;

export interface LivePool {
  address: PublicKey;
  pool: VirtualPool;
  config: PoolConfig;
  currentPoint: BN;
}

export function client(rpcUrl: string): DynamicBondingCurveClient {
  return DynamicBondingCurveClient.create(new Connection(rpcUrl, "confirmed"), "confirmed");
}

export async function fetchPool(c: DynamicBondingCurveClient, address: PublicKey | string): Promise<LivePool> {
  const addr = typeof address === "string" ? new PublicKey(address) : address;
  const pool = await c.state.getPool(addr);
  if (!pool) throw new Error(`no DBC pool at ${addr.toBase58()}`);
  const config = await c.state.getPoolConfig(pool.poolState.config);
  if (!config) throw new Error(`pool ${addr.toBase58()} points at a missing config ${pool.poolState.config.toBase58()}`);
  const currentPoint = await getCurrentPoint(c.connection, config.activationType);
  return { address: addr, pool, config, currentPoint };
}

/**
 * The holder's base-token balance in base units. Reads the associated token
 * account first (one RPC, works on every RPC including forks that do not
 * index by owner); falls back to an owner scan for wallets that hold the
 * mint in a non-associated account. 0 when none.
 */
export async function holderBalance(connection: Connection, owner: PublicKey, mint: PublicKey, tokenProgram?: PublicKey): Promise<BN> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  try {
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return new BN(bal.value.amount);
  } catch {
    // no ATA, or RPC could not read it
  }
  try {
    const res = await connection.getTokenAccountsByOwner(owner, { mint }, "confirmed");
    let total = new BN(0);
    for (const { pubkey } of res.value) {
      const bal = await connection.getTokenAccountBalance(pubkey, "confirmed");
      total = total.add(new BN(bal.value.amount));
    }
    return total;
  } catch {
    return new BN(0);
  }
}

export interface LiveReportOptions {
  rpcUrl: string;
  pool: string;
  /** Wallet whose position to report. Omit for a market-only report. */
  holder?: string;
  /** Reference buy size in whole quote units. Default 100. */
  referenceBuyQuote?: number;
}

export interface LiveReport {
  pool: string;
  baseMint: string;
  quoteMint: string;
  config: string;
  creator: string;
  holder?: string;
  currentPoint: number;
  activationType: number;
  report: DownsideReport;
  fetchedAt: string;
}

export async function liveReport(o: LiveReportOptions): Promise<LiveReport> {
  const c = client(o.rpcUrl);
  const live = await fetchPool(c, o.pool);
  const quoteDec = quoteDecimalsFor(live.config);
  const holder = o.holder ? new PublicKey(o.holder) : undefined;
  const holderBase = holder ? await holderBalance(c.connection, holder, live.pool.poolState.baseMint) : new BN(0);
  const ref = new BN(Math.round((o.referenceBuyQuote ?? 100) * 10 ** quoteDec));
  const report = buildReport({ pool: live.pool, config: live.config, currentPoint: live.currentPoint, holderBase, referenceBuyQuote: ref });
  return {
    pool: live.address.toBase58(),
    baseMint: live.pool.poolState.baseMint.toBase58(),
    quoteMint: live.config.quoteMint.toBase58(),
    config: live.pool.poolState.config.toBase58(),
    creator: live.pool.poolState.creator.toBase58(),
    holder: holder?.toBase58(),
    currentPoint: live.currentPoint.toNumber(),
    activationType: live.config.activationType,
    report,
    fetchedAt: new Date().toISOString(),
  };
}

/** Every pool launched from one config, with a market-only report each. Issuer view. */
export async function scanConfig(rpcUrl: string, configAddress: string, referenceBuyQuote = 100): Promise<LiveReport[]> {
  const c = client(rpcUrl);
  const cfgKey = new PublicKey(configAddress);
  const config = await c.state.getPoolConfig(cfgKey);
  if (!config) throw new Error(`no DBC config at ${configAddress}`);
  const pools = await c.state.getPoolsByConfig(cfgKey);
  const currentPoint = await getCurrentPoint(c.connection, config.activationType);
  const quoteDec = quoteDecimalsFor(config);
  const ref = new BN(Math.round(referenceBuyQuote * 10 ** quoteDec));
  return pools.map(({ publicKey, account }) => ({
    pool: publicKey.toBase58(),
    baseMint: account.poolState.baseMint.toBase58(),
    quoteMint: config.quoteMint.toBase58(),
    config: configAddress,
    creator: account.poolState.creator.toBase58(),
    currentPoint: currentPoint.toNumber(),
    activationType: config.activationType,
    report: buildReport({ pool: account, config, currentPoint, holderBase: new BN(0), referenceBuyQuote: ref }),
    fetchedAt: new Date().toISOString(),
  }));
}

/** Recent pool addresses on a network, newest last. For picking a sample to report on. */
export async function samplePools(rpcUrl: string, count = 10): Promise<string[]> {
  const conn = new Connection(rpcUrl, "confirmed");
  const c = DynamicBondingCurveClient.create(conn, "confirmed");
  const size = c.state.program.account.virtualPool.size;
  const accs = await conn.getProgramAccounts(DYNAMIC_BONDING_CURVE_PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ dataSize: size }],
  });
  return accs.slice(-count).map((a) => a.pubkey.toBase58());
}
