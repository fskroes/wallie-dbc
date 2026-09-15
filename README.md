# wallie-dbc

**If I buy into this launch now and it never graduates, what do I get back?**

A Meteora DBC launch is priced on the way in. Nobody prints the way out. This repo answers the exit question for tokenized-stock launches, from on-chain state, and has a Wallie agent pay for the answer per report inside an allowance it cannot exceed.

Built for the Stocklana hackathon, Meteora DBC bounty. Companion to [AllowanceKit / Wallie](https://github.com/fskroes/wallet_pay) (npm `allowance-kit`), which supplies the x402 `upto` payment channel. This repo holds all DBC-specific code; AllowanceKit stays zero-dependency.

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
| Web page | `web/index.html` | Scrub through a simulated launch; see the live timeline. Static, no build step. |

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
npm test                                 # 21 tests, all offline

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
