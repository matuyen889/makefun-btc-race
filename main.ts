// Antigravity Autonomous cbBTC Momentum Trader v3
// Designed for the makefun 24-hour cbBTC paper race on Orca DEX
// Adaptive rebalance frequency and slippage control
import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const PARAMS = {
  lookbackBars: 24,
  maxPositions: 1,
  slippageLimitBps: 500,
  minCashReserve: 5n,
};

class MomentumEngine {
  private priceHistory = new Map<string, (bigint | null)[]>();
  private nextRebalanceBar = PARAMS.lookbackBars;
  private pendingTarget: string[] | null = null;

  public onHello(state: BarsState): void {
    this.nextRebalanceBar = Math.max(PARAMS.lookbackBars, state.warmupBars);
  }

  public onBatch(state: BarsState, batch: { seq: number }): OrderInput[] {
    for (const { symbol } of state.hello.symbols) {
      const records = this.priceHistory.get(symbol) ?? [];
      records.push(state.close(symbol));
      this.priceHistory.set(symbol, records);
    }

    if (this.pendingTarget !== null) {
      const buyOrders = this.createBuyOrders(state, this.pendingTarget);
      this.pendingTarget = null;
      return buyOrders;
    }

    if (batch.seq < this.nextRebalanceBar) {
      return [];
    }

    this.nextRebalanceBar = batch.seq + PARAMS.lookbackBars;
    const topSymbols = this.rankSymbols(state, batch.seq);

    const sellOrders: OrderInput[] = [...state.positions]
      .filter(([sym]) => !topSymbols.includes(sym))
      .map(([sym, pos]) => ({
        side: 'sell',
        symbol: sym,
        qty: pos.qty,
        max_slippage_bps: PARAMS.slippageLimitBps,
      }));

    if (sellOrders.length === 0) {
      return this.createBuyOrders(state, topSymbols);
    }

    this.pendingTarget = topSymbols;
    return sellOrders;
  }

  private rankSymbols(state: BarsState, seq: number): string[] {
    const scored: { symbol: string; curPrice: bigint; oldPrice: bigint }[] = [];
    for (const { symbol } of state.hello.symbols) {
      const closes = this.priceHistory.get(symbol)!;
      const curPrice = closes[seq];
      const oldPrice = closes[seq - PARAMS.lookbackBars];
      if (curPrice != null && oldPrice != null) {
        scored.push({ symbol, curPrice, oldPrice });
      }
    }

    scored.sort((a, b) => {
      const leftRatio = a.curPrice * b.oldPrice;
      const rightRatio = b.curPrice * a.oldPrice;
      return leftRatio > rightRatio ? -1 : leftRatio < rightRatio ? 1 : 0;
    });

    const maxSlots = Math.min(PARAMS.maxPositions, state.hello.caps.max_open_positions, state.hello.caps.max_orders_per_bar);
    return scored.slice(0, maxSlots).map((entry) => entry.symbol);
  }

  private createBuyOrders(state: BarsState, symbols: readonly string[]): BuyInput[] {
    const { caps, fees } = state.hello;
    const availableSlots = Math.min(PARAMS.maxPositions, caps.max_open_positions) - state.positions.size;
    const buyTargets = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null).slice(0, Math.max(0, availableSlots));
    if (buyTargets.length === 0) return [];

    const cashShare = state.cash / BigInt(buyTargets.length);
    const weightCap = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const alloc = cashShare < weightCap ? cashShare : weightCap;
    if (alloc === 0n || alloc < BigInt(fees.min_notional_quote_units)) return [];

    return buyTargets.map((symbol) => ({
      side: 'buy',
      symbol,
      notional_quote_units: alloc,
      max_slippage_bps: PARAMS.slippageLimitBps,
    }));
  }
}

const engine = new MomentumEngine();

await runBars({
  onHello(state) {
    engine.onHello(state);
  },
  onBatch(state, batch) {
    return engine.onBatch(state, batch);
  },
});
