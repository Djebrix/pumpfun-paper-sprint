// First-Outsider: a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Idea (an entry-timing strategy, not a price-momentum, dip-reversion or
// creator-rug strategy): be the first outside buyer. A new bonding curve
// opens with the creator's own buy; the crowd arrives a few slots later and
// the price usually tops out once it does. This bot buys only while the
// opening tape is still crowd-free — at most two non-creator buyers have
// traded, nobody has sold yet, and the creator's own opening buy is small
// (at most 1 SOL, so the launch is not a whale front-run). It buys the
// smallest viable size (the 1%-of-real-reserve cap, at least 0.01 SOL so the
// round trip counts and the tx fee stays small) and exits fast: take profit
// +15%, stop loss -12%, at most 10 slots held, or the moment any sell trade
// prints after the buy fills (the first seller is the exit signal — the
// opening crowd is leaving). Buys carry a tight 500 bps slippage cap so a
// fill is refused when the price already ran away during the 2-slot
// latency; sells go out wide open so an exit is never stuck.
//
// Why this shape: on the dev window the whole edge sits in the first few
// trades and decays with every later buyer (measured on the kit dataset:
// entries taken after 2+ outside buyers average ~3x the per-coin loss of
// crowd-free entries, and adding into a rising curve loses outright). The
// bot therefore trades small, trades early, trades often across many
// coins, and never averages down, never pyramids, never holds a dead
// curve. Max drawdown on dev is ~1%; the cost is that most round trips
// are small losers and the profit comes from the minority that print
// +15% before any seller appears.
//
// Deterministic by construction: pure function of the batches the harness
// sends — no clock, no randomness, no I/O, no environment reads. All
// arithmetic is integer (bigint) lamport math; iteration is over
// insertion-ordered maps fed by the batch stream, so the two graded
// executions produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// --- entry parameters (chosen on the dev window, preferring flat regions) ---
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n; // 0.10 SOL target per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: smallest counted round trip
const MIN_REAL_SOL = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.30 SOL real reserve
const MAX_REAL_SOL = LAMPORTS_PER_SOL * 30n; // 30 SOL real reserve
const MAX_AGE_SLOTS = 30; // entry only in the first 30 slots of a curve's life
const MAX_OUTSIDE_BUYERS = 2; // at most this many non-creator buyers so far
const MAX_CREATOR_BUY_LAMPORTS = LAMPORTS_PER_SOL; // creator's opening buys, at most 1 SOL
const BUY_SLIPPAGE_BPS = 500; // refuse the fill if the price ran >5% in the latency
const SELL_SLIPPAGE_BPS = 10_000;
const TAKE_PROFIT_NUM = 115n; // value >= cost * 115/100
const STOP_LOSS_NUM = 88n; // value <= cost * 88/100
const MAX_HOLD_SLOTS = 10;
const CURVE_FEE_BPS = 125n; // 95 protocol + 30 creator, the hello fallbacks

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** What the opening tape of one curve has shown so far. */
interface Tape {
  createdSlot: number | null;
  creator: Pubkey | null;
  /** SOL the creator has bought since creation (lamports). */
  creatorBuyLamports: bigint;
  /** Distinct non-creator wallets that have bought. */
  outsideBuyers: Set<Pubkey>;
  /** Any sell has printed on this curve. */
  anySell: boolean;
}

interface Held {
  /** Slot of the batch in which the position first appeared (its buy filled). */
  openedSlot: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Mints whose sell is already in flight: never send a second sell. */
const exiting = new Set<Pubkey>();
/** Mints decided for good (exited, or closed by the harness): never re-enter. */
const done = new Set<Pubkey>();

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: null, creator: null, creatorBuyLamports: 0n, outsideBuyers: new Set(), anySell: false };
    tapes.set(mint, t);
  }
  return t;
}

/** Net SOL a full sell of `tokens` would pay now (curve + tx fees deducted). */
function positionValueLamports(state: BotState, mint: Pubkey, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || tokens <= 0n) return 0n;
  const q = (tokens * curve.virtual_quote_reserves) / (curve.virtual_token_reserves + tokens);
  const fee = ceilDiv(q * CURVE_FEE_BPS, 10_000n);
  const net = q - fee - state.txFeeLamports();
  return net > 0n ? net : 0n;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // --- fold this batch's events into the opening tapes ---
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.createdSlot = e.slot;
        t.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        if (!e.is_buy) {
          t.anySell = true;
        } else if (t.creator !== null && e.user === t.creator) {
          t.creatorBuyLamports += BigInt(e.sol_amount);
        } else {
          t.outsideBuyers.add(e.user);
        }
      }
    }

    // --- track positions: note newly filled ones, forget closed ones ---
    for (const [mint] of held) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        done.add(mint);
      }
    }
    for (const mint of state.positions.keys()) {
      if (!held.has(mint)) held.set(mint, { openedSlot: slot });
    }
    for (const mint of exiting) {
      if (!state.positions.has(mint)) exiting.delete(mint);
    }

    // --- exits first: any sell printing after the buy filled ends the trade ---
    const soldAfterBuy = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent' || e.is_buy) continue;
      const h = held.get(e.mint);
      if (h !== undefined && slot > h.openedSlot) soldAfterBuy.add(e.mint);
    }
    for (const [mint, pos] of state.positions) {
      if (exiting.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const h = held.get(mint);
      if (h === undefined) continue;
      const value = positionValueLamports(state, mint, pos.token_amount);
      const cost = pos.cost_lamports;
      const exit =
        value * 100n <= cost * STOP_LOSS_NUM ||
        value * 100n >= cost * TAKE_PROFIT_NUM ||
        slot - h.openedSlot > MAX_HOLD_SLOTS ||
        soldAfterBuy.has(mint);
      if (!exit) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      exiting.add(mint);
      done.add(mint);
    }

    // --- entries: crowd-free opening tapes only ---
    let free = state.freeCashLamports();
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    const pendingBuys = new Set<Pubkey>();
    for (const p of state.pending.values()) if (p.order.side === 'buy') pendingBuys.add(p.order.mint);

    const candidates: Pubkey[] = [];
    for (const e of batch.events) {
      if (!candidates.includes(e.mint)) candidates.push(e.mint);
    }
    for (const mint of candidates) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      if (state.positions.has(mint) || pendingBuys.has(mint) || done.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tapes.get(mint);
      if (t === undefined || t.createdSlot === null) continue;
      if (slot - t.createdSlot > MAX_AGE_SLOTS) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL || curve.real_quote_reserves > MAX_REAL_SOL) continue;
      if (t.anySell) continue;
      if (t.outsideBuyers.size > MAX_OUTSIDE_BUYERS) continue;
      if (t.creatorBuyLamports > MAX_CREATOR_BUY_LAMPORTS) continue;
      const amount = state.maxBuyLamports(mint) < STAKE_LAMPORTS ? state.maxBuyLamports(mint) : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      slotsLeft -= 1;
    }
    return orders;
  },
});
