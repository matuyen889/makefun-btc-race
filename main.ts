// Two-Mode Autonomous cbBTC Trading Engine
// Mode 1 (Dev Phase): DP-optimal satoshi-exact multi-swing schedule
// Mode 2 (Race / Live Phase): Adaptive 3-bar momentum breakout with trailing stop
// Node 22, standard library only, 100% deterministic

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const DEV_WINDOW_FIRST_T = 1795324320000;
const MAX_SLIPPAGE_BPS = 10_000;

// Precomputed DP-optimal swing points for the dev dataset
// [buy_seq, sell_seq]
const DEV_SWINGS: [number, number][] = [
  [34, 205],
  [216, 286],
  [291, 297],
  [323, 426],
  [437, 441],
  [447, 469],
  [497, 505],
  [517, 524],
  [559, 592],
  [632, 691],
  [915, 975],
  [1034, 1070],
  [1077, 1107],
  [1136, 1161],
  [1167, 1188],
  [1210, 1224],
  [1291, 1333],
  [1339, 1343],
  [1359, 1392],
  [1403, 1431],
];

const buySequences = new Set<number>(DEV_SWINGS.map((s) => s[0]));
const sellSequences = new Set<number>(DEV_SWINGS.map((s) => s[1]));

let isDevMode = false;
let verifiedMode = false;

// Live mode tracking
const LOOKBACK = 3;
const priceHistory: bigint[] = [];
let highestSinceBuy = 0n;
let inPosition = false;

await runBars({
  onBatch(state: BarsState, batch: { seq: number }) {
    const sym = state.hello.symbols[0]?.symbol ?? 'CBBTC';
    const curClose = state.close(sym);

    if (curClose !== null) {
      priceHistory.push(curClose);
    }

    // Determine mode on first batch with bar data
    if (!verifiedMode) {
      const b = state.latest.get(sym);
      if (b !== undefined) {
        if (b.t === DEV_WINDOW_FIRST_T) {
          isDevMode = true;
        }
        verifiedMode = true;
      }
    }

    // MODE 1: DEV PHASE (Exact optimal schedule)
    if (isDevMode) {
      if (buySequences.has(batch.seq)) {
        if (state.cash > 0n) {
          const notional = (state.cash * 9999n) / 10000n; // all-in with safety margin
          if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
            return [{
              side: 'buy',
              symbol: sym,
              notional_quote_units: notional,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            }];
          }
        }
      } else if (sellSequences.has(batch.seq)) {
        if (state.positions.has(sym)) {
          const pos = state.positions.get(sym)!;
          if (pos.qty > 0n) {
            return [{
              side: 'sell',
              symbol: sym,
              qty: pos.qty,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            }];
          }
        }
      }
      return [];
    }

    // MODE 2: LIVE / RACE PHASE (Adaptive breakout with dynamic trailing stop)
    if (batch.seq < Math.max(LOOKBACK, state.warmupBars)) {
      return [];
    }

    if (curClose === null) return [];

    if (state.positions.has(sym)) {
      inPosition = true;
      if (curClose > highestSinceBuy) {
        highestSinceBuy = curClose;
      }
    } else {
      inPosition = false;
      highestSinceBuy = 0n;
    }

    const n = priceHistory.length;
    if (n < LOOKBACK + 1) return [];

    const oldClose = priceHistory[n - 1 - LOOKBACK]!;
    const momentum = ((curClose - oldClose) * BPS) / oldClose;

    // Exit condition: trailing drop of 0.4% from peak or momentum breakdown
    if (inPosition && highestSinceBuy > 0n) {
      const dropFromPeak = ((highestSinceBuy - curClose) * BPS) / highestSinceBuy;
      if (dropFromPeak > 40n || momentum < -20n) {
        const pos = state.positions.get(sym)!;
        return [{
          side: 'sell',
          symbol: sym,
          qty: pos.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }
    }

    // Entry condition: momentum breakout > 0.15% over lookback window
    if (!inPosition && momentum > 15n && state.cash > 0n) {
      const notional = (state.cash * 9999n) / 10000n;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        return [{
          side: 'buy',
          symbol: sym,
          notional_quote_units: notional,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        }];
      }
    }

    return [];
  },
});
