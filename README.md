# wallie-dbc

**If I buy into this launch now and it never graduates, what do I get back?**

A Meteora DBC launch is priced on the way in. Nobody prints the way out. This repo answers the exit question for tokenized-stock launches, from on-chain state, and has a Wallie agent pay for the answer per report inside an allowance it cannot exceed.

Built for the Stocklana hackathon, Meteora DBC bounty. Companion to [AllowanceKit / Wallie](https://github.com/fskroes/AllowanceKit) (npm `allowance-kit`), which supplies the x402 `upto` payment channel. This repo holds all DBC-specific code; AllowanceKit stays zero-dependency.

## What it does

| Piece | File | What |
| --- | --- | --- |
| Equity launch spec → DBC config | `config/equity-curve.ts` | An issuer writes opening price, listing price, float, lockup, flip window. Out comes the exact `ConfigParameters` the DBC program accepts. Pure. |
| Downside report | `src/report.ts` | Exit value now, fee to leave, shortfall to graduation, buys to graduate, locked supply. Every quote goes through the SDK's own swap math. Pure. |
| Offline simulator | `src/simulate.ts` | Replays buys and sells against a config with no chain, so the report can be shown before anyone launches. |
| Live reader | `src/reader.ts` | Fetches a pool, its config, the current point and a holder's balance from any RPC. Works on mainnet, devnet and surfnet forks. |
| Paid report server | `src/server.ts` | An x402 `upto` seller. $0.10 ceiling per call, $0.01 charged per report, the rest refunded. A failed report charges nothing. |
| Watcher agent | `src/agent.ts` | A Wallie buyer that polls a launch, raises alerts (exit haircut, stalled raise, fee spike, lock-heavy, complete, migrated), and stops when its allowance no longer fits the ceiling. |
| Launch script | `scripts/launch.ts` | `createConfig` as partner, `createPoolWithFirstBuy` as creator. Writes `launch.<network>.json`. |
| Trade helper | `scripts/trade.ts` | Buy or sell on a launched pool. Used by the demo to move the market between polls. |
| Demo | `demo/run.ts` | Agent watches the real surfnet pool while another wallet buys. Prints the money trail and writes `web/data.json`. |
| Web page | `web/index.html` | Scrub through a simulated launch; see the live timeline. Static, no build step. Published at https://www.onewallie.com/dbc.html on the Wallie site (data pinned from this repo by `onewallie-site/scripts/sync-dbc.mjs`); GitHub Pages serves the same page as a mirror. |

## The mapping

| IPO term | DBC field |
| --- | --- |
| opening price | `initialMarketCap` → `sqrtStartPrice` |
| listing price | `migrationMarketCap` → `migrationSqrtPrice` |
| float | `percentageSupplyOnMigration` → `migrationBaseThreshold` |
| book (raise target) | `migrationQuoteThreshold` = float × listing price |
| curve shares | `swapBaseAmount`, two-segment curve priced at the geometric mean |
| treasury (unissued) | `leftover` → `leftoverReceiver` |
| flipping penalty | `baseFee` linear scheduler, opening fee decays to resting fee over the flip window |
| insider lockup | `lockedVesting`, cliff counted from migration |
| listing venue | `migrationOption = MET_DAMM_V2`, 50/50 permanently locked LP |
| settlement | `quoteMint` = USDC |

The identity DBC enforces: USDC collected on the curve becomes the graduation pool's quote side, paired with the float at the listing price. So the raise is fixed by float and listing price, and the curve must sell exactly enough shares between opening and listing to collect it. Any shares not needed go back to the issuer as treasury.

## Quick start

```sh
npm install --force
npm run build
npm test                                 # 25 tests, all offline

node dist/src/cli.js spec                # the DBC config for the default ACMEx spec
node dist/src/cli.js simulate            # replay five trades, report after each
node dist/src/cli.js report <pool> --holder <wallet> --network solana   # any live mainnet DBC pool
node dist/src/cli.js scan <config> --network solana                     # every pool on a config
```

Launch and demo on the surfnet mainnet fork (free, real DBC program):

```sh
node dist/scripts/launch.js --network surfnet --first-buy 5000
node dist/demo/run.js --polls 4 --out web/data.json
node dist/scripts/build-sim.js           # web/sim.json for the page
python3 -m http.server -d web 4173       # open http://localhost:4173
```

Devnet needs funded keys in `.keys/` (devnet airdrops are rate limited). Mainnet refuses without `--i-mean-mainnet` and funded keys.

## What the demo proved

Launch on surfnet (mainnet fork, real program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`): see `launch.surfnet.json`. Pool `F3nFkEPrWkNV1BNJUTgAPGVcCLXTXRDmwrWv8PAEftXD`, config `J12Jp1aFYrSi2qTZ2PMVRxsefQdQb8BcAPtDJ7ki3v6k`.

The offline simulator and the live reader agree to the cent on the same first buy: 5,000 USDC in, 605.975 ACMEx out, exit value 4,704.5 USDC after a 145.5 USDC fee.

Four agent polls, three trades between them, raise moved from 0.2% to 23.4%. Spent $0.04 of a $0.50 allowance. Every poll: $0.10 escrowed, $0.01 charged, $0.09 refunded.

## Working on mainnet today

The reader is not fork-only. It reads any live pool of the real DBC program on Solana mainnet-beta, read-only, no key, no funds. Run from a fresh clone on 2026-09-20 against the public RPC:

```sh
node dist/src/cli.js report JEK34huFirCquM1UryNcE8DBdBEX1BGa9LtdZu1NhT5s --network solana
```

```
pool JEK34huFirCquM1UryNcE8DBdBEX1BGa9LtdZu1NhT5s
base 551YFrffnUEdwHcxjfK8PpWzriNRx8q1NuFdfN7zBAGS
quote So11111111111111111111111111111111111111112

phase              trading
price now          2.116e-8 SOL/TOKEN  (graduates at 5.000e-7)
raised             0.096 SOL of 85 SOL  (0.1%)
shortfall          84.9 SOL  = 1 reference buys
position           0 TOKEN  marked 0 SOL
exit value now     no position
sell fee now       400 bps  (rests at 400 bps)
locked supply      0 TOKEN  = 0.0% of post-graduation supply
```

Same command on a pool that already graduated, `JEKDS3mbrwcrqHzUtKmeC7G4b3sx6khdkfZUvxhdgMFx`: phase `migrated`, 200 SOL of 200 SOL raised, shortfall 0, sell fee 25 bps. Both pools were picked at random with `sample --network solana`; neither is ours.

Verify on an explorer:

- [pool JEK34hu…](https://solscan.io/account/JEK34huFirCquM1UryNcE8DBdBEX1BGa9LtdZu1NhT5s) (trading)
- [pool JEKDS3m…](https://solscan.io/account/JEKDS3mbrwcrqHzUtKmeC7G4b3sx6khdkfZUvxhdgMFx) (migrated)
- [DBC program](https://solscan.io/account/dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN)

The full `--json` output of both reports, with pool, config, creator and the fetch time, is pinned in `docs/mainnet-report-2026-09-20.json`. `test/mainnet-report.test.ts` checks that the pinned figures still come out of `buildReport`'s formatter and that the phases and addresses are consistent.

What is still fork-only: the ACMEx *launch* (`createConfig`, `createPoolWithFirstBuy`). Launching on mainnet creates a real token with no equity behind it, so the demo issuer runs on surfnet and the mainnet launch path stays behind `--i-mean-mainnet`.

## Where it would break

- `configFromParameters` in `src/simulate.ts` rebuilds a `PoolConfig` account from builder output. If the SDK renames a field, the simulator diverges from the chain. The test "reserves and price move together" and the surfnet cross-check are the guards.
- `baseAhead` in `src/report.ts` walks the curve from the current price. The SDK's own `getBaseTokenForSwap` overflows once the price passes the first segment, which is why this exists.
- Buys in the simulator use partial fill; the program does the same on the last buy that tops the curve. Sells use exact-in.
- Quote decimals are inferred: SOL 9, everything else 6. A quote mint with other decimals would misprint the figures (the ratios stay right).
- The report ignores the dynamic fee. Equity configs from this repo do not enable it; a foreign pool with dynamic fees will show a sell fee that is slightly low.
- Payment settlement in the demo is in-memory (the same `pinnedOperator` pattern as the Wallie MCP demo). Real USDC settlement uses `createSolanaUptoOperator` from `allowance-kit`; the seller in `src/server.ts` takes any `UptoOperator`.

## Honest limits

A DBC-launched mint has no equity backing by itself. This toolkit gives an issuer the launch mechanics and gives every buyer the downside figures. A real issuer must stand behind the token. The ACMEx launch is a demo on a fork, not a listing.

## License

MIT
