/**
 * Equity launch spec → Meteora DBC config parameters.
 *
 * This is the one place an issuer describes a tokenized-stock launch in
 * stock terms (opening price, listing price, float, lockup) and gets back the
 * exact `ConfigParameters` the DBC program accepts. Pure: no network, no keys.
 *
 * IPO term            → DBC field
 * opening price       → initialMarketCap  (price × total supply)
 * listing price       → migrationMarketCap
 * float               → percentageSupplyOnMigration
 * book (raise target) → migrationQuoteThreshold (derived by the SDK)
 * flipping penalty    → base fee scheduler, decays over `flipWindowHours`
 * insider lockup      → lockedVesting (cliff after graduation)
 * listing venue       → migration to DAMM v2
 * settlement asset    → quoteMint = USDC
 */
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
  /** Ticker, e.g. "ACMEx". Display only. */
  symbol: string;
  /** Long name, e.g. "Acme Robotics tokenized common". Display only. */
  name: string;
  /** Total token supply in whole tokens (shares). */
  totalShares: number;
  /** Price per share at the first trade, in USDC. Usually the Pyth reference. */
  openingPriceUsd: number;
  /** Price per share at graduation, in USDC. Must be above opening. */
  listingPriceUsd: number;
  /** Percent of supply that moves into the DAMM v2 pool at graduation (1..80). */
  floatPercent: number;
  /** Percent of supply locked for insiders, released after graduation. */
  insiderLockPercent: number;
  /** Days after graduation before the first insider unlock. */
  insiderCliffDays: number;
  /** Months of linear insider vesting after the cliff. 0 = unlock at cliff. */
  insiderVestMonths: number;
  /** Fee charged to trades in the first minutes after open, in bps. */
  openingFeeBps: number;
  /** Fee after the flip window has passed, in bps (25 minimum). */
  restingFeeBps: number;
  /** Hours over which the opening fee decays to the resting fee. */
  flipWindowHours: number;
  /** Share of trading fees the creator keeps, percent (0..100). */
  creatorFeeSharePercent: number;
}

export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;

/** A sane starting point: small-cap style, one-day flip window, one-year insider lock. */
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
  /** USDC the curve must collect before graduation (= float × listing price). */
  raiseTargetUsd: number;
  /** Tokens sold along the curve to collect the raise. */
  curveSupply: number;
  /** Tokens that seed the DAMM v2 pool at graduation. */
  floatSupply: number;
  /** Tokens locked for insiders. */
  lockedSupply: number;
  /** Authorized but unissued: supply − float − locked − curve. Returned to the issuer. */
  treasurySupply: number;
  /** Average price a curve buyer pays, geometric mean of opening and listing. */
  averageCurvePriceUsd: number;
}

/** Validate the spec. Throws a plain Error with the failing field named. */
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

/**
 * The book-building identity DBC enforces: USDC collected on the curve becomes
 * the graduation pool's quote side, paired with the float at the listing price.
 * So raise = float × listing, and the curve must sell exactly enough tokens
 * between opening and listing price to collect that raise. We price the curve
 * at the geometric mean, which is where the SDK's two-segment solver lands, and
 * hand any shares not needed back to the issuer as treasury (DBC "leftover").
 */
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

/** The SDK builder input. Exposed so tests can assert the mapping line by line. */
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

/** Build the on-chain config parameters for an equity launch. Pure. */
export function buildEquityConfig(s: EquityLaunchSpec): ConfigParameters {
  return buildCurveWithTwoSegments(toBuilderParams(s));
}
