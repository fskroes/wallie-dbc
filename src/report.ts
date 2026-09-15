/**
 * The downside report: four figures a DBC launch never shows a buyer.
 *
 *   exitValueNow    what your position sells for on the curve right now, after fees
 *   exitFeeNow      the fee the curve takes from that sale
 *   shortfall       USDC still needed before the pool graduates
 *   buysToGraduate  how many buys of a reference size close that gap
 *
 * plus the two facts that decide whether the gap can still close:
 *
 *   lockedSupply    tokens that unlock after graduation (dilution the buyer inherits)
 *   staleAfter      the activation point and whether trading has even opened
 *
 * Pure: takes on-chain state already fetched, returns numbers. Every quote
 * goes through the SDK's own swap math so the figures match what the program
 * would settle. Nothing here signs or sends.
 */
import BN from "bn.js";
import {
  TradeDirection,
  feeNumeratorToBps,
  Rounding,
  getBaseFeeHandler,
  getDeltaAmountBaseUnsigned,
  getPriceFromSqrtPrice,
  swapQuoteExactIn,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const MICRO = 1_000_000n;

export interface ReportInput {
  pool: VirtualPool;
  config: PoolConfig;
  /** Current slot or unix time, matching config.activationType. */
  currentPoint: BN;
  /** The holder's base-token balance in base units (10^tokenDecimal). */
  holderBase: BN;
  /** Reference buy size in quote units for the buys-to-graduate figure. */
  referenceBuyQuote: BN;
}

export interface DownsideReport {
  /** Pool phase from on-chain flags. */
  phase: "pending" | "trading" | "complete" | "migrated";
  /** Price now in quote per base, decimals applied. */
  priceNow: number;
  /** Price at graduation, decimals applied. */
  priceAtGraduation: number;
  /** Quote reserve now, in whole quote units. */
  raisedQuote: number;
  /** Migration threshold, in whole quote units. */
  raiseTargetQuote: number;
  /** raisedQuote / raiseTargetQuote, clamped 0..1. */
  progress: number;
  /** Quote still needed before graduation, whole units. */
  shortfallQuote: number;
  /** Buys of referenceBuyQuote needed to close the shortfall (fees included). */
  buysToGraduate: number;
  /** Holder position in whole base tokens. */
  holderTokens: number;
  /** Mark of the position at priceNow, whole quote units. */
  holderMarkQuote: number;
  /** What the position sells for on the curve right now, after fees, whole quote units. */
  exitValueNowQuote: number;
  /** Fee taken from that exit sale, whole quote units. */
  exitFeeNowQuote: number;
  /** exitValueNow / holderMark. 1 = full mark; below 1 is what the curve keeps. */
  exitHaircut: number;
  /** Current sell-side base fee in bps, after the scheduler has decayed. */
  sellFeeBpsNow: number;
  /** Lowest base fee the scheduler ever reaches, bps. */
  restingFeeBps: number;
  /** Tokens locked for vesting, whole base tokens. Dilution that lands after graduation. */
  lockedTokens: number;
  /** lockedTokens / (sold so far + float + locked). Share of post-graduation supply still locked. */
  lockedShareOfCirculating: number;
  /** Tokens that seed the graduation pool, whole base tokens. */
  floatTokens: number;
  /** Curve tokens sold so far, whole base tokens. */
  soldTokens: number;
  /** Activation point (slot or unix time). */
  activationPoint: number;
  /** True when currentPoint is before activationPoint. */
  notYetOpen: boolean;
  /** Why exit could not be quoted, when it could not. */
  exitNote?: string;
}

/**
 * Base tokens still on the curve between `sqrtPrice` and graduation. The SDK's
 * getBaseTokenForSwap assumes the walk starts at the curve start, so it
 * overflows once the price has passed the first segment. This walks each
 * segment from max(current, segment lower bound) instead.
 */
export function baseAhead(sqrtPrice: BN, config: PoolConfig): BN {
  let total = new BN(0);
  let lower = config.sqrtStartPrice;
  for (const seg of config.curve) {
    if (seg.sqrtPrice.isZero() || seg.liquidity.isZero()) break;
    const upper = BN.min(seg.sqrtPrice, config.migrationSqrtPrice);
    const from = BN.max(lower, sqrtPrice);
    if (upper.gt(from)) total = total.add(getDeltaAmountBaseUnsigned(from, upper, seg.liquidity, Rounding.Up));
    lower = seg.sqrtPrice;
    if (seg.sqrtPrice.gte(config.migrationSqrtPrice)) break;
  }
  return total;
}

function toWhole(v: BN, decimals: number): number {
  const s = v.toString();
  const pad = s.padStart(decimals + 1, "0");
  return Number(`${pad.slice(0, pad.length - decimals)}.${pad.slice(pad.length - decimals)}`);
}

/** The pool's phase from its flags and reserves. */
export function poolPhase(pool: VirtualPool, config: PoolConfig, currentPoint: BN): DownsideReport["phase"] {
  const s = pool.poolState;
  if (s.isMigrated) return "migrated";
  if (s.quoteReserve.gte(config.migrationQuoteThreshold)) return "complete";
  if (currentPoint.lt(s.activationPoint)) return "pending";
  return "trading";
}

/** Quote decimals: DBC configs carry only the base decimal; USDC and SOL quotes are 6 and 9. */
export function quoteDecimalsFor(config: PoolConfig): number {
  return config.quoteMint.toBase58() === "So11111111111111111111111111111111111111112" ? 9 : 6;
}

export function buildReport(input: ReportInput): DownsideReport {
  const { pool, config, currentPoint, holderBase, referenceBuyQuote } = input;
  const s = pool.poolState;
  const baseDec = config.tokenDecimal;
  const quoteDec = quoteDecimalsFor(config);
  const phase = poolPhase(pool, config, currentPoint);

  const priceNow = getPriceFromSqrtPrice(s.sqrtPrice, baseDec, quoteDec).toNumber();
  const priceAtGraduation = getPriceFromSqrtPrice(config.migrationSqrtPrice, baseDec, quoteDec).toNumber();
  const raisedQuote = toWhole(s.quoteReserve, quoteDec);
  const raiseTargetQuote = toWhole(config.migrationQuoteThreshold, quoteDec);
  const shortfallBn = BN.max(config.migrationQuoteThreshold.sub(s.quoteReserve), new BN(0));
  const shortfallQuote = toWhole(shortfallBn, quoteDec);
  const progress = raiseTargetQuote > 0 ? Math.min(1, Math.max(0, raisedQuote / raiseTargetQuote)) : 0;

  // Fee now, sell side. The scheduler decays from cliff to resting over its periods.
  const bf = config.poolFees.baseFee;
  const handler = getBaseFeeHandler(bf.cliffFeeNumerator, bf.firstFactor, bf.secondFactor, bf.thirdFactor, bf.baseFeeMode);
  const sellFeeNum = handler.getBaseFeeNumeratorFromIncludedFeeAmount(
    BN.max(currentPoint, s.activationPoint),
    s.activationPoint,
    TradeDirection.BaseToQuote,
    holderBase.isZero() ? new BN(1) : holderBase,
  );
  const sellFeeBpsNow = feeNumeratorToBps(sellFeeNum);
  const restingFeeBps = feeNumeratorToBps(handler.getMinBaseFeeNumerator());

  // Buys to graduate: a buy of referenceBuyQuote pays fee on input when fees are in quote,
  // so only the net amount lands in the reserve. Walk it through the SDK quote.
  let buysToGraduate = 0;
  if (phase === "trading" || phase === "pending") {
    const point = BN.max(currentPoint, s.activationPoint);
    try {
      const q = swapQuoteExactIn(pool, config, false, referenceBuyQuote, 0, false, point, false);
      const netIn = q.excludedFeeInputAmount.isZero() ? referenceBuyQuote : q.excludedFeeInputAmount;
      // ceil(shortfall / netIn)
      buysToGraduate = shortfallBn.isZero() ? 0 : shortfallBn.add(netIn).subn(1).div(netIn).toNumber();
    } catch {
      // The curve cannot absorb one reference buy: report at least one.
      buysToGraduate = shortfallBn.isZero() ? 0 : 1;
    }
  }

  // Exit now: sell the whole position back along the curve.
  const holderTokens = toWhole(holderBase, baseDec);
  const holderMarkQuote = holderTokens * priceNow;
  let exitValueNowQuote = 0;
  let exitFeeNowQuote = 0;
  let exitNote: string | undefined;
  if (holderBase.isZero()) {
    exitNote = "no position";
  } else if (phase === "migrated") {
    exitNote = "pool migrated; sell on the DAMM v2 pool instead";
  } else if (phase === "complete") {
    exitNote = "curve complete; swaps are closed until migration";
  } else {
    try {
      const q = swapQuoteExactIn(pool, config, true, holderBase, 0, false, BN.max(currentPoint, s.activationPoint), false);
      exitValueNowQuote = toWhole(q.outputAmount, quoteDec);
      exitFeeNowQuote = toWhole(q.tradingFee.add(q.protocolFee), quoteDec);
    } catch (e) {
      exitNote = `exit not quotable: ${(e as Error).message}`;
    }
  }
  const exitHaircut = holderMarkQuote > 0 ? exitValueNowQuote / holderMarkQuote : 0;

  // Locked supply from the vesting config: cliff + periods × per period.
  const lv = config.lockedVestingConfig;
  const lockedBn = lv.cliffUnlockAmount.add(lv.amountPerPeriod.mul(lv.numberOfPeriod));
  const lockedTokens = toWhole(lockedBn, baseDec);
  // Sold so far = curve supply minus what is still ahead of the current price.
  const aheadBn = baseAhead(s.sqrtPrice, config);
  const sold = toWhole(BN.max(config.swapBaseAmount.sub(aheadBn), new BN(0)), baseDec);
  const floatTokens = toWhole(config.migrationBaseThreshold, baseDec);
  const circulating = lockedTokens + sold + floatTokens;
  const lockedShareOfCirculating = circulating > 0 ? lockedTokens / circulating : 0;

  return {
    phase,
    priceNow,
    priceAtGraduation,
    raisedQuote,
    raiseTargetQuote,
    progress,
    shortfallQuote,
    buysToGraduate,
    holderTokens,
    holderMarkQuote,
    exitValueNowQuote,
    exitFeeNowQuote,
    exitHaircut,
    sellFeeBpsNow,
    restingFeeBps,
    lockedTokens,
    lockedShareOfCirculating,
    floatTokens,
    soldTokens: sold,
    activationPoint: s.activationPoint.toNumber(),
    notYetOpen: currentPoint.lt(s.activationPoint),
    exitNote,
  };
}

/** Plain-text rendering, one line per figure, for terminals and logs. */
export function fmtPrice(n: number): string {
  if (n === 0) return "0";
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

export function renderReport(r: DownsideReport, quoteSymbol = "USDC", baseSymbol = "TOKEN"): string {
  const money = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 })} ${quoteSymbol}`;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `phase              ${r.phase}${r.notYetOpen ? ` (opens at ${r.activationPoint})` : ""}`,
    `price now          ${fmtPrice(r.priceNow)} ${quoteSymbol}/${baseSymbol}  (graduates at ${fmtPrice(r.priceAtGraduation)})`,
    `raised             ${money(r.raisedQuote)} of ${money(r.raiseTargetQuote)}  (${pct(r.progress)})`,
    `shortfall          ${money(r.shortfallQuote)}  = ${r.buysToGraduate} reference buys`,
    `position           ${r.holderTokens.toLocaleString("en-US")} ${baseSymbol}  marked ${money(r.holderMarkQuote)}`,
    `exit value now     ${r.exitNote ? r.exitNote : `${money(r.exitValueNowQuote)}  after ${money(r.exitFeeNowQuote)} fee  (${pct(r.exitHaircut)} of mark)`}`,
    `sell fee now       ${r.sellFeeBpsNow} bps  (rests at ${r.restingFeeBps} bps)`,
    `locked supply      ${r.lockedTokens.toLocaleString("en-US")} ${baseSymbol}  = ${pct(r.lockedShareOfCirculating)} of post-graduation supply`,
  ];
  return lines.join("\n");
}
