import { krakenPairCode } from "./krakenPairs";

export type FuturesPair = "ETHUSDT" | "SOLUSDT";
export type VariantKey = "A-2x" | "B-2x";
export type Side = "long" | "short";

export const FUTURES_KRAKEN_PAIRS: Record<FuturesPair, string> = {
  ETHUSDT: krakenPairCode("ETHUSDT"),
  SOLUSDT: krakenPairCode("SOLUSDT"),
};

export const FUTURES_PAIR_LABELS: Record<FuturesPair, string> = {
  ETHUSDT: "ETH/USDT",
  SOLUSDT: "SOL/USDT",
};

// Stop/target as a plain price-move % (leverage does NOT change these — it only
// multiplies the $ result on the margin actually risked, same distance to trigger).
export const PAIR_PARAMS: Record<FuturesPair, { stopPct: number; targetPct: number; minNotionalUsd: number }> = {
  ETHUSDT: { stopPct: 6, targetPct: 9, minNotionalUsd: 20 },
  SOLUSDT: { stopPct: 7, targetPct: 10.5, minNotionalUsd: 5 },
};

export const VARIANT_PARAMS: Record<VariantKey, { leverage: number; exitStyle: "A" | "B" }> = {
  "A-2x": { leverage: 2, exitStyle: "A" },
  "B-2x": { leverage: 2, exitStyle: "B" },
};

export const STARTING_CASH = 100;
// Backtested: 4% produced a -92.9% max drawdown (way past the ~20% target) even after
// dropping shorts; 2% keeps it survivable (~-40%) without the $100 account being too
// small to clear Binance's minimum notional on most entries, the way 1% was.
export const RISK_PCT_PER_TRADE = 2; // % of current equity risked (at the stop) per new trade
export const MAX_OPEN_POSITIONS = 2;
export const DAILY_LOSS_PAUSE_PCT = 10; // pause new entries once today's PnL hits -10% of the day's starting equity
export const TAKER_FEE_PCT = 0.05; // simplification: every entry/exit modeled as taker (worse case, matches Binance futures taker fee)
export const FUNDING_PCT_PER_8H = 0.01; // typical perpetual funding baseline; Binance doesn't expose the live rate to the Worker

export interface FuturesPosition {
  side: Side;
  entryPrice: number;
  qty: number; // total size opened, in coin units
  qtyRemaining: number; // shrinks after a B-style partial take-profit
  margin: number; // $ posted at entry for the full qty (not yet reduced by partial closes)
  marginRemaining: number;
  leverage: number;
  openedAt: string; // ISO
  partialTaken: boolean;
  bestPrice: number; // extreme favorable price since entry (or since partial), for the B-style trailing stop
  lastFundingAt: string; // ISO, last time funding was charged
}

export interface ClosedTrade {
  pair: FuturesPair;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlUsd: number;
  reason: string;
  openedAt: string;
  closedAt: string;
}

export interface VariantState {
  cash: number;
  positions: Partial<Record<FuturesPair, FuturesPosition>>;
  trades: ClosedTrade[];
  dayStartEquity: number;
  lastDay: string; // YYYY-MM-DD (UTC), for resetting the daily-loss circuit breaker
  paused: boolean; // manual /parar
  blockedCount: number; // entries skipped by a circuit breaker or the minimum-notional check
}

export type FuturesSimFile = Record<VariantKey, VariantState>;

export function emptyVariantState(): VariantState {
  return { cash: STARTING_CASH, positions: {}, trades: [], dayStartEquity: STARTING_CASH, lastDay: "", paused: false, blockedCount: 0 };
}

export function emptyFuturesSimFile(): FuturesSimFile {
  return { "A-2x": emptyVariantState(), "B-2x": emptyVariantState() };
}
