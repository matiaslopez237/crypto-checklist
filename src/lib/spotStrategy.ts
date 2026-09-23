import type { BuyChecklistResult, Indicators } from "./types";

// Shared between the live Worker and the backtest, so both run the exact same
// buy-zone/hysteresis state machine instead of two implementations that could drift.

// How many extra points the buy score needs to gain (while still in the green
// zone) before re-notifying — e.g. price kept dropping toward support, a better
// entry than the one you were already told about.
export const BUY_SCORE_IMPROVEMENT_THRESHOLD = 15;

// Hysteresis ("colchon"): an alert only re-arms once the condition has backed off
// well past its trigger, not the instant it dips one tick below. Without this, a price
// hovering right at a threshold (e.g. 3% take profit) flips the flag on/off every few
// minutes and re-sends the same alert each time.
export const REARM_MARGIN_PCT = 1;
// Buy zone starts at score 75; it only counts as "left" below this, so a single
// criterion toggling (e.g. "near support", worth 20 pts) doesn't re-fire the entry alert.
export const BUY_ZONE_EXIT_SCORE = 65;

export function rearmConditions(
  ind: Indicators,
  pnlPct: number,
  stopLossPct: number,
  takeProfitPct: number,
  rearmMarginPct = REARM_MARGIN_PCT,
) {
  const distToResistance = ((ind.resistance20 - ind.price) / ind.resistance20) * 100;
  return {
    stopLoss: pnlPct > -stopLossPct + rearmMarginPct,
    takeProfit: pnlPct < takeProfitPct - rearmMarginPct,
    technical: ind.rsi14 === null || ind.rsi14 < 65 || distToResistance > 3,
    trendBreak: ind.sma50 === null || ind.price > ind.sma50 * 1.01,
  };
}

// Notifies once when a condition turns true, stays quiet while it remains true, and
// re-arms once it clears — so a real trigger always gets a fresh alert. Shared shape
// with handleAlert in worker.ts (that one's async, for sending Telegram messages;
// this one's sync, for the paper position's own dedup flags).
export function markIfActive(
  pos: { stopLossAlerted: boolean; takeProfitAlerted: boolean; technicalSellAlerted: boolean; trendBreakAlerted: boolean },
  flagKey: "stopLossAlerted" | "takeProfitAlerted" | "technicalSellAlerted" | "trendBreakAlerted",
  isActive: boolean,
  clearWhen: boolean = !isActive, // must imply !isActive; wider than it = hysteresis band
): boolean {
  const shouldFire = isActive && !pos[flagKey];
  if (isActive) pos[flagKey] = true;
  else if (clearWhen) pos[flagKey] = false;
  return shouldFire;
}

// The live Worker re-scores the still-forming daily candle every 15 minutes, so a
// score hovering at the buy cutoff can leave and re-enter the zone several times in
// one day. A daily-timeframe signal shouldn't fire more than once per day.
export const ENTRY_COOLDOWN_MS = 24 * 3600_000;

export interface BuyZoneState {
  lastVerdict: string | null;
  lastNotifiedBuyScore: number | null;
  lastEntryAt?: number | null;
}

// Mutates `state` in place (same convention as the Worker's PairAlertState) and
// reports whether this is a fresh buy-zone entry or a meaningful improvement within
// an ongoing one — the two triggers for a paper buy (and, live, a Telegram alert).
export function evaluateBuyZone(
  state: BuyZoneState,
  buyResult: BuyChecklistResult,
  scoreImprovementThreshold = BUY_SCORE_IMPROVEMENT_THRESHOLD,
  buyZoneExitScore = BUY_ZONE_EXIT_SCORE,
  nowMs: number = Date.now(),
): { enteredBuyZoneNow: boolean; buyZoneImprovedEnough: boolean } {
  let enteredBuyZoneNow = false;
  let buyZoneImprovedEnough = false;

  if (buyResult.verdict === "buy") {
    // Re-entry inside the cooldown is the same signal again: resume silently, still
    // comparing improvements against the score that was actually notified.
    const cooledDown = state.lastEntryAt == null || nowMs - state.lastEntryAt >= ENTRY_COOLDOWN_MS;
    const enteredNow = state.lastVerdict !== "buy" && cooledDown;
    if (enteredNow) state.lastEntryAt = nowMs;
    const improvedEnough =
      !enteredNow && state.lastNotifiedBuyScore !== null && buyResult.score >= state.lastNotifiedBuyScore + scoreImprovementThreshold;

    enteredBuyZoneNow = enteredNow;
    buyZoneImprovedEnough = improvedEnough;

    if (enteredNow || improvedEnough) state.lastNotifiedBuyScore = buyResult.score;
  }

  // A verdict slipping just under the buy cutoff doesn't count as leaving the zone until
  // the score falls below buyZoneExitScore, so a criterion flickering at its edge can't
  // re-fire the entry alert (or a paper buy) every few minutes.
  const stillInBuyZone = state.lastVerdict === "buy" && buyResult.score >= buyZoneExitScore;
  const inCooldown = state.lastEntryAt != null && nowMs - state.lastEntryAt < ENTRY_COOLDOWN_MS;
  if (buyResult.verdict !== "buy" && !stillInBuyZone && !inCooldown) {
    state.lastNotifiedBuyScore = null;
  }
  state.lastVerdict = buyResult.verdict === "buy" || stillInBuyZone ? "buy" : buyResult.verdict;

  return { enteredBuyZoneNow, buyZoneImprovedEnough };
}
