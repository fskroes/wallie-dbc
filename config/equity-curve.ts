import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithTwoSegments,
  type BuildCurveWithTwoSegmentsParams,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const USDC_MINT = {
  "solana": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
} as const;

export interface EquityLaunchSpec {
  symbol: string;
  name: string;
  totalShares: number;
  openingPriceUsd: number;
  listingPriceUsd: number;
  floatPercent: number;
  insiderLockPercent: number;
  insiderCliffDays: number;
  insiderVestMonths: number;
  openingFeeBps: number;
  restingFeeBps: number;
  flipWindowHours: number;
  creatorFeeSharePercent: number;
}

export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;

export const DEFAULT_SPEC: EquityLaunchSpec = {
  symbol: "ACMEx",
  name: "Acme Robotics tokenized common",
  totalShares: 1_000_000,
  openingPriceUsd: 8,
  listingPriceUsd: 12,
  floatPercent: 20,
  insiderLockPercent: 30,
  insiderCliffDays: 180,
  insiderVestMonths: 12,
  openingFeeBps: 300,
  restingFeeBps: 25,
  flipWindowHours: 24,
  creatorFeeSharePercent: 50,
};

export interface SpecSummary {
  initialMarketCapUsd: number;
  migrationMarketCapUsd: number;
  raiseTargetUsd: number;
  curveSupply: number;
  floatSupply: number;
  lockedSupply: number;
  treasurySupply: number;
  averageCurvePriceUsd: number;
}

export function validateSpec(s: EquityLaunchSpec): void {
  const fail = (field: keyof EquityLaunchSpec, why: string) => {
    throw new Error(`spec.${field}: ${why}`);
  };
  if (!Number.isInteger(s.totalShares) || s.totalShares <= 0) fail("totalShares", "must be a positive integer");
  if (!(s.openingPriceUsd > 0)) fail("openingPriceUsd", "must be > 0");
  if (!(s.listingPriceUsd > s.openingPriceUsd)) fail("listingPriceUsd", "must be above openingPriceUsd");
  if (!(s.floatPercent >= 1 && s.floatPercent <= 80)) fail("floatPercent", "must be 1..80");
  if (!(s.insiderLockPercent >= 0 && s.insiderLockPercent <= 80)) fail("insiderLockPercent", "must be 0..80");
  if (s.floatPercent + s.insiderLockPercent >= 95) fail("insiderLockPercent", "float + lock leaves no curve supply");
  if (!(s.insiderCliffDays >= 0)) fail("insiderCliffDays", "must be >= 0");
  if (!(s.insiderVestMonths >= 0)) fail("insiderVestMonths", "must be >= 0");
  if (!(s.restingFeeBps >= 25 && s.restingFeeBps <= 9900)) fail("restingFeeBps", "must be 25..9900");
  if (!(s.openingFeeBps >= s.restingFeeBps && s.openingFeeBps <= 9900)) fail("openingFeeBps", "must be >= restingFeeBps and <= 9900");
  if (!(s.flipWindowHours >= 0)) fail("flipWindowHours", "must be >= 0");
  if (!(s.creatorFeeSharePercent >= 0 && s.creatorFeeSharePercent <= 100)) fail("creatorFeeSharePercent", "must be 0..100");
}

export function summarizeSpec(s: EquityLaunchSpec): SpecSummary {
  validateSpec(s);
  const floatSupply = Math.floor((s.totalShares * s.floatPercent) / 100);
  const lockedSupply = Math.floor((s.totalShares * s.insiderLockPercent) / 100);
  const raiseTargetUsd = s.listingPriceUsd * floatSupply;
  const averageCurvePriceUsd = Math.sqrt(s.openingPriceUsd * s.listingPriceUsd);
  const curveSupply = Math.ceil(raiseTargetUsd / averageCurvePriceUsd);
  const treasurySupply = s.totalShares - floatSupply - lockedSupply - curveSupply;
  if (treasurySupply < 0) {
    throw new Error(
      `spec.floatPercent: float ${s.floatPercent}% plus lock ${s.insiderLockPercent}% plus the ${curveSupply} shares the curve must sell ` +
        `exceed totalShares by ${-treasurySupply}; lower the float, the lock, or raise openingPriceUsd`,
    );
  }
  return {
    initialMarketCapUsd: s.openingPriceUsd * s.totalShares,
    migrationMarketCapUsd: s.listingPriceUsd * s.totalShares,
    raiseTargetUsd,
    curveSupply,
    floatSupply,
    lockedSupply,
    treasurySupply,
    averageCurvePriceUsd,
  };
}

export function toBuilderParams(s: EquityLaunchSpec): BuildCurveWithTwoSegmentsParams {
  validateSpec(s);
  const sum = summarizeSpec(s);
  const periods = s.flipWindowHours > 0 ? Math.max(1, Math.min(60, Math.round(s.flipWindowHours * 4))) : 0;
  const vestPeriods = s.insiderVestMonths > 0 ? s.insiderVestMonths : 1;
  const cliffAmount = s.insiderVestMonths > 0 ? 0 : sum.lockedSupply;
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.SIX,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: s.totalShares,
      leftover: sum.treasurySupply,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: s.openingFeeBps,
          endingFeeBps: s.restingFeeBps,
          numberOfPeriod: periods,
          totalDuration: Math.round(s.flipWindowHours * SECONDS_PER_HOUR),
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: s.creatorFeeSharePercent,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: sum.lockedSupply,
      numberOfVestingPeriod: sum.lockedSupply > 0 ? vestPeriods : 0,
      cliffUnlockAmount: sum.lockedSupply > 0 ? cliffAmount : 0,
      totalVestingDuration: sum.lockedSupply > 0 ? vestPeriods * SECONDS_PER_MONTH : 0,
      cliffDurationFromMigrationTime: sum.lockedSupply > 0 ? s.insiderCliffDays * SECONDS_PER_DAY : 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: sum.initialMarketCapUsd,
    migrationMarketCap: sum.migrationMarketCapUsd,
    percentageSupplyOnMigration: s.floatPercent,
  };
}

export function buildEquityConfig(s: EquityLaunchSpec): ConfigParameters {
  return buildCurveWithTwoSegments(toBuilderParams(s));
}
