import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEC,
  buildEquityConfig,
  summarizeSpec,
  toBuilderParams,
  validateSpec,
  type EquityLaunchSpec,
} from "../config/equity-curve.ts";
import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  MigrationOption,
  TokenAuthorityOption,
  getPriceFromSqrtPrice,
  validateConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const spec = (o: Partial<EquityLaunchSpec> = {}): EquityLaunchSpec => ({ ...DEFAULT_SPEC, ...o });
/** The SDK validator also checks the leftover receiver, which is an account, not a curve parameter. */
const sdkAccepts = (s: EquityLaunchSpec) => validateConfigParameters({ ...buildEquityConfig(s), leftoverReceiver: PublicKey.unique() });

test("default spec validates and the SDK accepts the config", () => {
  validateSpec(DEFAULT_SPEC);
  assert.doesNotThrow(() => sdkAccepts(DEFAULT_SPEC));
});

test("summary follows the book-building identity: raise = float × listing", () => {
  const s = summarizeSpec(DEFAULT_SPEC);
  assert.equal(s.floatSupply, 200_000);
  assert.equal(s.raiseTargetUsd, 2_400_000);
  assert.equal(s.lockedSupply, 300_000);
  assert.equal(s.curveSupply + s.floatSupply + s.lockedSupply + s.treasurySupply, DEFAULT_SPEC.totalShares);
  assert.ok(s.averageCurvePriceUsd > DEFAULT_SPEC.openingPriceUsd && s.averageCurvePriceUsd < DEFAULT_SPEC.listingPriceUsd);
});

test("config encodes the IPO terms in DBC fields", () => {
  const c = buildEquityConfig(DEFAULT_SPEC);
  // threshold = raise in USDC micro
  assert.equal(c.migrationQuoteThreshold.toString(), "2400000000000");
  // start price = opening price
  const start = getPriceFromSqrtPrice(c.sqrtStartPrice, 6, 6).toNumber();
  assert.ok(Math.abs(start - 8) < 0.001, `start ${start}`);
  // last curve point = listing price
  const last = c.curve[c.curve.length - 1].sqrtPrice;
  const listing = getPriceFromSqrtPrice(last, 6, 6).toNumber();
  assert.ok(Math.abs(listing - 12) < 0.001, `listing ${listing}`);
  // flip window → linear scheduler from 300 to 25 bps over 24h in 60 periods
  assert.equal(c.poolFees.baseFee.baseFeeMode, BaseFeeMode.FeeSchedulerLinear);
  assert.equal(c.poolFees.baseFee.cliffFeeNumerator.toString(), "30000000");
  assert.equal(c.poolFees.baseFee.firstFactor, 60);
  assert.equal(c.poolFees.baseFee.secondFactor.toString(), String(Math.round((24 * 3600) / 60)));
  // insider lockup → vesting: 12 monthly periods, 180-day cliff, no cliff unlock
  assert.equal(c.lockedVesting.numberOfPeriod.toString(), "12");
  assert.equal(c.lockedVesting.cliffDurationFromMigrationTime.toString(), String(180 * 86_400));
  assert.equal(c.lockedVesting.cliffUnlockAmount.toString(), "0");
  assert.equal(c.lockedVesting.amountPerPeriod.mul(c.lockedVesting.numberOfPeriod).toString(), "300000000000");
  // listing venue and settlement
  assert.equal(c.migrationOption, MigrationOption.MET_DAMM_V2);
  assert.equal(c.activationType, ActivationType.Timestamp);
  assert.equal(c.tokenUpdateAuthority, TokenAuthorityOption.Immutable);
  assert.equal(c.tokenSupply?.preMigrationTokenSupply.toString(), "1000000000000");
});

test("no lockup and no flip window give zero vesting and a flat fee", () => {
  const c = buildEquityConfig(spec({ insiderLockPercent: 0, flipWindowHours: 0, openingFeeBps: 25 }));
  assert.equal(c.lockedVesting.numberOfPeriod.toString(), "0");
  assert.equal(c.lockedVesting.amountPerPeriod.toString(), "0");
  assert.equal(c.poolFees.baseFee.firstFactor, 0);
  assert.equal(c.poolFees.baseFee.cliffFeeNumerator.toString(), "2500000");
  assert.doesNotThrow(() => sdkAccepts(spec({ insiderLockPercent: 0, flipWindowHours: 0, openingFeeBps: 25 })));
});

test("cliff-only lockup unlocks everything at the cliff", () => {
  const p = toBuilderParams(spec({ insiderVestMonths: 0 }));
  assert.equal(p.lockedVesting.numberOfVestingPeriod, 1);
  assert.equal(p.lockedVesting.cliffUnlockAmount, 300_000);
});

test("validation names the failing field", () => {
  assert.throws(() => validateSpec(spec({ listingPriceUsd: 8 })), /spec\.listingPriceUsd/);
  assert.throws(() => validateSpec(spec({ floatPercent: 0 })), /spec\.floatPercent/);
  assert.throws(() => validateSpec(spec({ restingFeeBps: 10 })), /spec\.restingFeeBps/);
  assert.throws(() => validateSpec(spec({ openingFeeBps: 10 })), /spec\.openingFeeBps/);
  assert.throws(() => validateSpec(spec({ totalShares: 10.5 })), /spec\.totalShares/);
  assert.throws(() => validateSpec(spec({ creatorFeeSharePercent: 101 })), /spec\.creatorFeeSharePercent/);
});

test("a float too large for the supply is rejected with the shortfall named", () => {
  assert.throws(() => summarizeSpec(spec({ floatPercent: 60, insiderLockPercent: 30 })), /exceed totalShares by/);
});

test("treasury absorbs supply the curve does not need", () => {
  const s = summarizeSpec(spec({ floatPercent: 10 }));
  assert.equal(s.floatSupply, 100_000);
  assert.ok(s.treasurySupply > 0);
  assert.doesNotThrow(() => sdkAccepts(spec({ floatPercent: 10 })));
});
