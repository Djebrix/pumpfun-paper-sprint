[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Djebrix/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Djebrix/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# First-Outsider — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One strategy program, `main.ts` on Node 22, speaking `agent-fun/replay/v2`.

## Strategy

Be the first outside buyer. A new bonding curve opens with the creator's own buy; the crowd arrives a few slots later and the price usually tops out once it does. The bot buys only while the opening tape is still crowd-free — at most two non-creator buyers have traded, nobody has sold yet, and the creator's own opening buy is at most 1 SOL. It exits fast: take profit +15%, stop loss −12%, at most 10 slots held, or the moment any sell trade prints after the buy fills. Buys carry a tight 500 bps slippage cap so a fill is refused when the price already ran away during the 2-slot latency.

It never averages down, never pyramids, and never holds a dead curve. Everything it runs is in this repository; no network, no secrets, no randomness, no clock — the two graded executions produce byte-identical action logs.

## Files

- `main.ts` — the strategy
- `vendor/makefun-bot.ts` — the kit's replay-v2 shim, vendored byte for byte

## License

MIT — see [LICENSE](LICENSE).
