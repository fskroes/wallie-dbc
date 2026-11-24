import BN from "bn.js";
import { Decimal } from "decimal.js";
import { PublicKey } from "@solana/web3.js";
import {
  getBaseTokenForSwap,
  getMigrationBaseToken,
  getMigrationQuoteAmountFromMigrationQuoteThreshold,
  swapQuoteExactIn,
  swapQuotePartialFill,
  type ConfigParameters,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { buildReport, type DownsideReport } from "./report.ts";

export const DEFAULT_QUOTE_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export function configFromParameters(p: ConfigParameters, quoteMint: PublicKey = DEFAULT_QUOTE_MINT): PoolConfig {
  const zero = new BN(0);
  const curve = [...p.curve];
  while (curve.length < 20) curve.push({ sqrtPrice: zero, liquidity: zero });
  const migrationSqrtPrice = p.curve[p.curve.length - 1].sqrtPrice;
  const lv = p.lockedVesting;
  const lockedTotal = lv.cliffUnlockAmount.add(lv.amountPerPeriod.mul(lv.numberOfPeriod));
  const swapBaseAmount = getBaseTokenForSwap(p.sqrtStartPrice, migrationSqrtPrice, p.curve);
  const migrationQuoteAmount = getMigrationQuoteAmountFromMigrationQuoteThreshold(
    new Decimal(p.migrationQuoteThreshold.toString()),
    p.migrationFee.feePercentage,
  );
  const migrationBaseThreshold = getMigrationBaseToken(
    new BN(migrationQuoteAmount.floor().toFixed()),
    migrationSqrtPrice,
    p.migrationOption,
  );
  void lockedTotal;
  return {
    quoteMint,
    feeClaimer: PublicKey.default,
    leftoverReceiver: PublicKey.default,
    poolFees: {
      baseFee: { ...p.poolFees.baseFee, padding0: [] },
      dynamicFee: p.poolFees.dynamicFee
        ? { initialized: 1, padding: [], ...p.poolFees.dynamicFee, padding2: [], binStepU128: new BN(0) }
        : {
            initialized: 0,
            padding: [],
            maxVolatilityAccumulator: 0,
            variableFeeControl: 0,
            binStep: 0,
            filterPeriod: 0,
            decayPeriod: 0,
            reductionFactor: 0,
            padding2: [],
            binStepU128: new BN(0),
          },
    },
    partnerLiquidityVestingInfo: emptyLiquidityVesting(),
    creatorLiquidityVestingInfo: emptyLiquidityVesting(),
    padding0: [],
    padding1: 0,
    collectFeeMode: p.collectFeeMode,
    migrationOption: p.migrationOption,
    activationType: p.activationType,
    tokenDecimal: p.tokenDecimal,
    version: 0,
    tokenType: p.tokenType,
    quoteTokenFlag: 0,
    partnerPermanentLockedLiquidityPercentage: p.partnerPermanentLockedLiquidityPercentage,
    partnerLiquidityPercentage: p.partnerLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: p.creatorPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: p.creatorLiquidityPercentage,
    migrationFeeOption: p.migrationFeeOption,
    fixedTokenSupplyFlag: p.tokenSupply ? 1 : 0,
    creatorTradingFeePercentage: p.creatorTradingFeePercentage,
    tokenUpdateAuthority: p.tokenUpdateAuthority,
    migrationFeePercentage: p.migrationFee.feePercentage,
    creatorMigrationFeePercentage: p.migrationFee.creatorFeePercentage,
    padding2: [],
    swapBaseAmount,
    migrationQuoteThreshold: p.migrationQuoteThreshold,
    migrationBaseThreshold,
    migrationSqrtPrice,
    lockedVestingConfig: { ...lv, padding: new BN(0) },
    preMigrationTokenSupply: p.tokenSupply?.preMigrationTokenSupply ?? zero,
    postMigrationTokenSupply: p.tokenSupply?.postMigrationTokenSupply ?? zero,
    migratedCollectFeeMode: 0,
    migratedDynamicFee: 0,
    migratedPoolFeeBps: 0,
    migratedPoolBaseFeeMode: 0,
    enableFirstSwapWithMinFee: p.enableFirstSwapWithMinFee ? 1 : 0,
    migratedCompoundingFeeBps: 0,
    poolCreationFee: p.poolCreationFee,
    migratedPoolBaseFeeBytes: [],
    sqrtStartPrice: p.sqrtStartPrice,
    curve,
  } as unknown as PoolConfig;
}

function emptyLiquidityVesting() {
  return {
    isInitialized: 0,
    vestingPercentage: 0,
    padding: [],
    bpsPerPeriod: 0,
    numberOfPeriods: 0,
    frequency: new BN(0),
    cliffDurationFromMigrationTime: new BN(0),
  };
}

export function freshPool(config: PoolConfig, activationPoint: BN): VirtualPool {
  const zero = new BN(0);
  return {
    poolState: {
      volatilityTracker: {
        lastUpdateTimestamp: zero,
        padding: [],
        sqrtPriceReference: zero,
        volatilityAccumulator: zero,
        volatilityReference: zero,
      },
      config: PublicKey.default,
      creator: PublicKey.default,
      baseMint: PublicKey.default,
      baseVault: PublicKey.default,
      quoteVault: PublicKey.default,
      baseReserve: config.preMigrationTokenSupply,
      quoteReserve: zero,
      protocolBaseFee: zero,
      protocolQuoteFee: zero,
      partnerBaseFee: zero,
      partnerQuoteFee: zero,
      sqrtPrice: config.sqrtStartPrice,
      activationPoint,
      poolType: 0,
      isMigrated: 0,
      isPartnerWithdrawSurplus: 0,
      isProtocolWithdrawSurplus: 0,
      migrationProgress: 0,
      isWithdrawLeftover: 0,
      isCreatorWithdrawSurplus: 0,
      migrationFeeWithdrawStatus: 0,
      metrics: { totalProtocolBaseFee: zero, totalProtocolQuoteFee: zero, totalTradingBaseFee: zero, totalTradingQuoteFee: zero },
      finishCurveTimestamp: zero,
      creatorBaseFee: zero,
      creatorQuoteFee: zero,
      legacyCreationFeeBits: 0,
      creationFeeBits: 0,
      hasSwap: 0,
      padding0: [],
    },
  } as unknown as VirtualPool;
}

export interface SimStep {
  side: "buy" | "sell";
  amount: number;
  at: number;
  who: string;
}

export interface SimResult {
  step: SimStep;
  balances: Record<string, number>;
  report: DownsideReport;
  rejected?: string;
}

export function applyTrade(pool: VirtualPool, config: PoolConfig, side: "buy" | "sell", amountIn: BN, at: BN) {
  const q =
    side === "buy"
      ? swapQuotePartialFill(pool, config, false, amountIn, 0, false, at, false)
      : swapQuoteExactIn(pool, config, true, amountIn, 0, false, at, false);
  const s = pool.poolState;
  if (side === "buy") {
    s.quoteReserve = s.quoteReserve.add(q.excludedFeeInputAmount);
    s.baseReserve = s.baseReserve.sub(q.outputAmount);
  } else {
    s.baseReserve = s.baseReserve.add(q.excludedFeeInputAmount);
    s.quoteReserve = s.quoteReserve.sub(q.outputAmount).sub(q.tradingFee).sub(q.protocolFee);
  }
  s.sqrtPrice = q.nextSqrtPrice;
  s.hasSwap = 1;
  return q;
}

export function simulate(
  config: PoolConfig,
  steps: SimStep[],
  opts: { activationPoint: number; watch: string; referenceBuyQuote: number; quoteDecimals?: number },
): SimResult[] {
  const quoteDec = opts.quoteDecimals ?? 6;
  const baseDec = config.tokenDecimal;
  const pool = freshPool(config, new BN(opts.activationPoint));
  const balances: Record<string, BN> = {};
  const out: SimResult[] = [];
  const refBuy = toUnits(opts.referenceBuyQuote, quoteDec);
  for (const step of steps) {
    const at = new BN(step.at);
    balances[step.who] ??= new BN(0);
    let rejected: string | undefined;
    try {
      if (step.side === "buy") {
        const q = applyTrade(pool, config, "buy", toUnits(step.amount, quoteDec), at);
        balances[step.who] = balances[step.who].add(q.outputAmount);
      } else {
        const want = toUnits(step.amount, baseDec);
        const have = balances[step.who];
        const amt = BN.min(want, have);
        if (amt.isZero()) throw new Error(`${step.who} holds nothing to sell`);
        applyTrade(pool, config, "sell", amt, at);
        balances[step.who] = have.sub(amt);
      }
    } catch (e) {
      rejected = (e as Error).message;
    }
    const report = buildReport({
      pool,
      config,
      currentPoint: at,
      holderBase: balances[opts.watch] ?? new BN(0),
      referenceBuyQuote: refBuy,
    });
    out.push({
      step,
      balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, Number(v.toString()) / 10 ** baseDec])),
      report,
      rejected,
    });
  }
  return out;
}

export function toUnits(whole: number, decimals: number): BN {
  return new BN(Math.round(whole * 10 ** decimals).toString());
}
