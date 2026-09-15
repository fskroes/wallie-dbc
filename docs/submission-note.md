# Stocklana submission: Meteora DBC bounty addendum

Entry: Wallie (AllowanceKit). Main-track project is the tokenized-stock monitor and the x402 `upto` payment rail. This repo is the Meteora DBC bounty part of the same single entry.

## One sentence

An issuer toolkit that writes a tokenized-stock launch in IPO terms onto Meteora DBC, plus the four downside figures every buyer should see before they commit, kept fresh by a Wallie agent that pays per report inside an allowance.

## Originality of the DBC use

- Launch terms in stock language (opening price, listing price, float, lockup, flip window) instead of memecoin knobs. The mapping is documented field by field.
- The book-building identity: raise = float × listing price, curve supply derived, surplus returned to the issuer as treasury. Not a market-cap guess.
- Flip-window fee scheduler as an anti-flipping rule, insider lockup as `lockedVesting` from migration, DAMM v2 graduation as the listing.
- The exit question. Exit value now, fee to leave, shortfall, buys to graduate, post-graduation unlock. Computed from `VirtualPool` + `PoolConfig` through the SDK's own swap math, for any DBC pool on mainnet.

## Technical soundness

- 21 offline tests. The SDK's `validateConfigParameters` accepts every config the builder produces.
- Real launch on a mainnet fork running the real program: `createConfig`, `createPoolWithFirstBuy`, three swaps. Simulator and live reader agree to the cent.
- No web3.js v1 leaks into AllowanceKit. This repo owns the DBC dependency.

## Life after the hackathon

- The report server is an x402 seller. Any agent with `allowance-kit` can buy reports today.
- The issuer CLI works against mainnet with funded keys and `--i-mean-mainnet`.
- The alerts map to the Wallie notify channel (email, Telegram) already shipped in AllowanceKit.

## Links

- Repo: (fill after push)
- Live page: (fill after deploy)
- Launch record: `launch.surfnet.json`
- AllowanceKit v0.6.0: https://www.npmjs.com/package/allowance-kit
