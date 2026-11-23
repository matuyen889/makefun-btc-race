// Baseline: cross-sectional momentum trading bot v2
// Optimized lookback and slippage controls for cbBTC 24h race
import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK_BARS = 48;
/** The most symbols it holds: fewer than half the universe (7 in solana-bars-1h-01), so it rotates. */
const MOMENTUM_TOP_N = 3;
const MAX_SLIPPAGE_BPS = 10_000;

/** Each universe symbol's latest close as of every batch so far (null before its first bar), by seq. */
const history = new Map<string, (bigint | null)[]>();
/** The next rebalance bar; set from hello: max(LOOKBACK_BARS, the warm-up's batches). */
let nextRebalance = LOOKBACK_BARS;
/** The symbols to buy on this batch, chosen on the rebalance bar before it (whose sells have now filled). */
let entering: string[] | null = null;

/** How many symbols it holds at most: n, MOMENTUM_TOP_N unless a cap is tighter. */
const slots = (state: BarsState) => Math.min(MOMENTUM_TOP_N, state.hello.caps.max_open_positions, state.hello.caps.max_orders_per_bar);

/** The top n symbols by trailing return as of batch `seq`, best first. */
function target(state: BarsState, seq: number): string[] {
  const ranked: { symbol: string; now: bigint; then: bigint }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const closes = history.get(symbol)!;
    const now = closes[seq];
    const then = closes[seq - LOOKBACK_BARS];
    if (now !== null && now !== undefined && then !== null && then !== undefined) ranked.push({ symbol, now, then });
  }
  // now_a / then_a > now_b / then_b, exactly; Array.prototype.sort is stable, so ties keep universe order.
  ranked.sort((a, b) => {
    const l = a.now * b.then;
    const r = b.now * a.then;
    return l > r ? -1 : l < r ? 1 : 0;
  });
  return ranked.slice(0, slots(state)).map((x) => x.symbol);
}

function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
  const { caps, fees } = state.hello;
  const room = slots(state) - state.positions.size;
  const coming = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null).slice(0, room > 0 ? room : 0);
  if (coming.length === 0) return [];
  const even = state.cash / BigInt(coming.length);
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const slice = even < byWeight ? even : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  return coming.map((symbol) => ({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }));
}

await runBars({
  onHello(state) {
    nextRebalance = Math.max(LOOKBACK_BARS, state.warmupBars);
  },
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol) ?? [];
      closes.push(state.close(symbol));
      history.set(symbol, closes);
    }
    if (entering !== null) {
      const orders = buys(state, entering);
      entering = null;
      return orders;
    }
    if (batch.seq < nextRebalance) return [];
    nextRebalance = batch.seq + LOOKBACK_BARS;
    const want = target(state, batch.seq);
    const sells: OrderInput[] = [...state.positions]
      .filter(([symbol]) => !want.includes(symbol))
      .map(([symbol, p]) => ({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }));
    if (sells.length === 0) return buys(state, want);
    entering = want;
    return sells;
  },
});
