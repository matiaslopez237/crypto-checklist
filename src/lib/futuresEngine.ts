import type { Indicators } from "./types";
import {
  DAILY_LOSS_PAUSE_PCT,
  FUNDING_PCT_PER_8H,
  MAX_OPEN_POSITIONS,
  RISK_PCT_PER_TRADE,
  TAKER_FEE_PCT,
  type ClosedTrade,
  type FuturesPair,
  type FuturesPosition,
  type Side,
  type VariantState,
} from "./futuresTypes";

// --- Trend filter (daily SMA200) -------------------------------------------------
// A plain SMA200 cross whipsaws in sideways markets (price ping-pongs across the line,
// flipping the direction every few days). Same cushion + SMA50 confirmation the spot
// buy checklist already uses (its "longTermTrend"/"midTermTrend" items), instead of a
// bare cross, so the direction only flips once it's actually clear.

export function trendSide(dailyInd: Indicators): Side | null {
  if (dailyInd.sma200 === null) return null;
  const longOk = dailyInd.price >= dailyInd.sma200 * 1.03 && (dailyInd.sma50 === null || dailyInd.sma50 >= dailyInd.sma200 * 0.95);
  const shortOk = dailyInd.price <= dailyInd.sma200 * 0.97 && (dailyInd.sma50 === null || dailyInd.sma50 <= dailyInd.sma200 * 1.05);
  if (longOk) return "long";
  if (shortOk) return "short";
  return null; // inside the band, or SMA50 doesn't confirm — sit out rather than guess
}

// --- Entry timing score (1h candles) ---------------------------------------------
// Mirrors the spot buy checklist's *timing* signals (support/resistance, RSI, chasing,
// volume) — the trend itself is already gated separately by the daily SMA200, so this
// only asks "is this a decent moment to get in", long or short.

export interface EntryScore {
  score: number;
  maxScore: number;
  passed: boolean;
}

const ENTRY_WEIGHTS = { nearLevel: 35, rsiOk: 25, notChasing: 20, volumeConfirm: 20 };
const ENTRY_MAX = Object.values(ENTRY_WEIGHTS).reduce((a, b) => a + b, 0);
const ENTRY_THRESHOLD = 0.7; // fraction of ENTRY_MAX needed to trigger

export function scoreEntry(ind: Indicators, side: Side): EntryScore {
  let score = 0;

  if (side === "long") {
    const distToSupport = ((ind.price - ind.support20) / ind.support20) * 100;
    if (distToSupport <= 3) score += ENTRY_WEIGHTS.nearLevel;
    if (ind.rsi14 !== null && ind.rsi14 < 65) score += ENTRY_WEIGHTS.rsiOk;
    if (ind.change3d !== null && ind.change3d <= 5) score += ENTRY_WEIGHTS.notChasing;
  } else {
    const distToResistance = ((ind.resistance20 - ind.price) / ind.resistance20) * 100;
    if (distToResistance <= 3) score += ENTRY_WEIGHTS.nearLevel;
    if (ind.rsi14 !== null && ind.rsi14 > 35) score += ENTRY_WEIGHTS.rsiOk;
    if (ind.change3d !== null && ind.change3d >= -5) score += ENTRY_WEIGHTS.notChasing;
  }

  if (ind.avgVolume20 !== null && ind.lastVolume >= ind.avgVolume20 * 0.7) score += ENTRY_WEIGHTS.volumeConfirm;

  return { score, maxScore: ENTRY_MAX, passed: score >= ENTRY_MAX * ENTRY_THRESHOLD };
}

// --- Position sizing ---------------------------------------------------------------
// Sized so a stop-loss hit costs ~RISK_PCT_PER_TRADE% of current equity, regardless of
// leverage — leverage only changes how much margin is needed to reach that same $ risk,
// it doesn't change the price distance to the stop.

export function sizePosition(
  equity: number,
  stopPct: number,
  leverage: number,
  price: number,
  minNotionalUsd: number,
): { margin: number; qty: number } | null {
  const riskUsd = equity * (RISK_PCT_PER_TRADE / 100);
  const lossFractionOfMargin = (stopPct / 100) * leverage;
  const margin = riskUsd / lossFractionOfMargin;
  const notional = margin * leverage;
  if (notional < minNotionalUsd) return null;
  if (margin > equity) return null;
  return { margin, qty: notional / price };
}

// --- Managing an open position -------------------------------------------------

export type PositionAction =
  | { type: "hold" }
  | { type: "closeAll"; reason: string }
  | { type: "closePartial"; pct: number; reason: string }
  | { type: "updateTrail"; bestPrice: number };

export function evaluatePosition(
  pos: FuturesPosition,
  price: number,
  stopPct: number,
  targetPct: number,
  exitStyle: "A" | "B",
): PositionAction {
  const move = pos.side === "long" ? ((price - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - price) / pos.entryPrice) * 100;

  if (!pos.partialTaken) {
    if (move <= -stopPct) return { type: "closeAll", reason: "stop loss" };
    if (move >= targetPct) {
      if (exitStyle === "A") return { type: "closeAll", reason: "objetivo alcanzado" };
      return { type: "closePartial", pct: 50, reason: "objetivo alcanzado (parcial, resto con trailing)" };
    }
    return { type: "hold" };
  }

  // Remainder after a B-style partial: stop already moved to breakeven, then trails by
  // the same distance behind the best price reached — never worse than breakeven.
  const trailStop =
    pos.side === "long"
      ? Math.max(pos.entryPrice, pos.bestPrice * (1 - stopPct / 100))
      : Math.min(pos.entryPrice, pos.bestPrice * (1 + stopPct / 100));
  const hit = pos.side === "long" ? price <= trailStop : price >= trailStop;
  if (hit) return { type: "closeAll", reason: "trailing stop" };

  const improved = pos.side === "long" ? price > pos.bestPrice : price < pos.bestPrice;
  if (improved) return { type: "updateTrail", bestPrice: price };
  return { type: "hold" };
}

// --- Fees, funding, PnL ---------------------------------------------------------

export function closeSlice(pos: FuturesPosition, exitPrice: number, qtyToClose: number): { pnlUsd: number; marginReturned: number } {
  const grossPnl =
    pos.side === "long" ? (exitPrice - pos.entryPrice) * qtyToClose : (pos.entryPrice - exitPrice) * qtyToClose;
  const entryFee = qtyToClose * pos.entryPrice * (TAKER_FEE_PCT / 100);
  const exitFee = qtyToClose * exitPrice * (TAKER_FEE_PCT / 100);
  const marginReturned = pos.margin * (qtyToClose / pos.qty);
  return { pnlUsd: grossPnl - entryFee - exitFee, marginReturned };
}

// Binance doesn't expose the live funding rate to a Worker (no auth'd endpoint call
// budget for that here), so this charges a fixed typical baseline every 8h a position
// stays open — a simplification, documented so the simulation's results aren't read as
// more precise than they are.
export function accrueFunding(pos: FuturesPosition, nowMs: number): number {
  const last = new Date(pos.lastFundingAt).getTime();
  const periodMs = 8 * 3600_000;
  const periods = Math.floor((nowMs - last) / periodMs);
  if (periods <= 0) return 0;
  pos.lastFundingAt = new Date(last + periods * periodMs).toISOString();
  const notional = pos.qtyRemaining * pos.entryPrice;
  return notional * (FUNDING_PCT_PER_8H / 100) * periods;
}

// --- Equity & circuit breakers ---------------------------------------------------

export function unrealizedPnl(pos: FuturesPosition, price: number): number {
  return pos.side === "long" ? (price - pos.entryPrice) * pos.qtyRemaining : (pos.entryPrice - price) * pos.qtyRemaining;
}

export function computeEquity(variant: VariantState, prices: Partial<Record<FuturesPair, number>>): number {
  let equity = variant.cash;
  for (const [pair, pos] of Object.entries(variant.positions) as [FuturesPair, FuturesPosition | undefined][]) {
    if (!pos) continue;
    const price = prices[pair];
    equity += pos.marginRemaining + (price !== undefined ? unrealizedPnl(pos, price) : 0);
  }
  return equity;
}

export function resetDayIfNeeded(variant: VariantState, todayStr: string, equityNow: number): void {
  if (variant.lastDay !== todayStr) {
    variant.lastDay = todayStr;
    variant.dayStartEquity = equityNow;
  }
}

export function canOpenPosition(variant: VariantState, equityNow: number): { ok: boolean; reason?: string } {
  if (variant.paused) return { ok: false, reason: "pausado manualmente (/parar)" };
  const openCount = Object.keys(variant.positions).length;
  if (openCount >= MAX_OPEN_POSITIONS) return { ok: false, reason: "máximo de posiciones abiertas" };
  const dayLossPct = ((equityNow - variant.dayStartEquity) / variant.dayStartEquity) * 100;
  if (dayLossPct <= -DAILY_LOSS_PAUSE_PCT) return { ok: false, reason: "freno diario (-10%)" };
  return { ok: true };
}

export function newTrade(
  pair: FuturesPair,
  pos: FuturesPosition,
  exitPrice: number,
  qtyClosed: number,
  pnlUsd: number,
  reason: string,
): ClosedTrade {
  return {
    pair,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    qty: qtyClosed,
    pnlUsd,
    reason,
    openedAt: pos.openedAt,
    closedAt: new Date().toISOString(),
  };
}
