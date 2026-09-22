import type { BuyChecklistResult, ChecklistItem, Indicators, SellChecklistResult, Verdict } from "./types";

// Weights reflect how much each signal should move the buy decision.
// Long-term trend context matters most; volume is a soft, noisy confirmation.
const WEIGHTS = {
  longTermTrend: 25,
  midTermTrend: 15,
  nearSupport: 20,
  rsiNotOverbought: 15,
  notChasing: 10,
  roomToResistance: 10,
  volumeConfirmation: 5,
};
const MAX_SCORE = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

// Threshold values (not weights) pulled out as an overridable config so the backtest
// can sweep them one at a time against the exact same scoring code production uses,
// instead of a separate reimplementation. Defaults match the values this file always
// used before the config existed.
export interface BuyChecklistConfig {
  longTermTrendCushion: number; // price >= sma200 * this
  midTermTrendCushion: number; // sma50 >= sma200 * this
  nearSupportPct: number; // max % above the 20d support
  rsiOverboughtThreshold: number; // rsi14 must be below this
  notChasingPct: number; // max 3-day change %
  roomToResistancePct: number; // min % of room to the 20d resistance
  volumeConfirmationRatio: number; // lastVolume >= avgVolume20 * this
  buyThresholdRatio: number; // score >= maxScore * this -> "buy"
  watchThresholdRatio: number; // score >= maxScore * this -> "watch"
}

// buyThresholdRatio lowered 0.75 -> 0.70 (2026-09-22): backtested 2018-2026, a
// combined change with buildSellChecklist's overboughtRsiThreshold (70 -> 80) took
// total return from +177.9% to +274.7%, for a max drawdown of -21.0% (was -16.7%).
const DEFAULT_BUY_CONFIG: BuyChecklistConfig = {
  longTermTrendCushion: 0.97,
  midTermTrendCushion: 0.95,
  nearSupportPct: 4,
  rsiOverboughtThreshold: 70,
  notChasingPct: 12,
  roomToResistancePct: 5,
  volumeConfirmationRatio: 0.8,
  buyThresholdRatio: 0.7,
  watchThresholdRatio: 0.5,
};

export function buildBuyChecklist(ind: Indicators, config: Partial<BuyChecklistConfig> = {}): BuyChecklistResult {
  const cfg = { ...DEFAULT_BUY_CONFIG, ...config };
  const items: ChecklistItem[] = [];

  if (ind.sma200 !== null) {
    const threshold = ind.sma200 * cfg.longTermTrendCushion;
    items.push({
      label: "Contexto de fondo no bajista (SMA200)",
      passed: ind.price >= threshold,
      detail: `Precio ${ind.price.toFixed(2)} vs. SMA200*${cfg.longTermTrendCushion} ${threshold.toFixed(2)}`,
      weight: WEIGHTS.longTermTrend,
    });
  } else {
    items.push({
      label: "Contexto de fondo no bajista (SMA200)",
      passed: false,
      detail: "SMA200 aún no disponible (faltan velas)",
      weight: WEIGHTS.longTermTrend,
    });
  }

  if (ind.sma50 !== null && ind.sma200 !== null) {
    const threshold = ind.sma200 * cfg.midTermTrendCushion;
    items.push({
      label: "Tendencia de mediano plazo sana (SMA50)",
      passed: ind.sma50 >= threshold,
      detail: `SMA50 ${ind.sma50.toFixed(2)} vs. SMA200*${cfg.midTermTrendCushion} ${threshold.toFixed(2)}`,
      weight: WEIGHTS.midTermTrend,
    });
  } else {
    items.push({
      label: "Tendencia de mediano plazo sana (SMA50)",
      passed: false,
      detail: "SMA50 o SMA200 aún no disponible",
      weight: WEIGHTS.midTermTrend,
    });
  }

  const distToSupport = ((ind.price - ind.support20) / ind.support20) * 100;
  items.push({
    label: "Cerca del soporte de 20 días",
    passed: distToSupport <= cfg.nearSupportPct,
    detail: `${distToSupport.toFixed(1)}% sobre el soporte (${ind.support20.toFixed(2)})`,
    weight: WEIGHTS.nearSupport,
  });

  if (ind.rsi14 !== null) {
    items.push({
      label: "RSI(14) sin sobrecompra",
      passed: ind.rsi14 < cfg.rsiOverboughtThreshold,
      detail: `RSI ${ind.rsi14.toFixed(1)}`,
      weight: WEIGHTS.rsiNotOverbought,
    });
  } else {
    items.push({
      label: "RSI(14) sin sobrecompra",
      passed: false,
      detail: "RSI aún no disponible",
      weight: WEIGHTS.rsiNotOverbought,
    });
  }

  if (ind.change3d !== null) {
    items.push({
      label: "No persiguiendo una suba fuerte",
      passed: ind.change3d <= cfg.notChasingPct,
      detail: `Variación 3 días: ${ind.change3d.toFixed(1)}%`,
      weight: WEIGHTS.notChasing,
    });
  } else {
    items.push({
      label: "No persiguiendo una suba fuerte",
      passed: false,
      detail: "Sin datos suficientes",
      weight: WEIGHTS.notChasing,
    });
  }

  const distToResistance = ((ind.resistance20 - ind.price) / ind.resistance20) * 100;
  items.push({
    label: "Espacio hasta la resistencia de 20 días",
    passed: distToResistance >= cfg.roomToResistancePct,
    detail: `${distToResistance.toFixed(1)}% de recorrido hasta ${ind.resistance20.toFixed(2)}`,
    weight: WEIGHTS.roomToResistance,
  });

  if (ind.avgVolume20 !== null) {
    const threshold = ind.avgVolume20 * cfg.volumeConfirmationRatio;
    items.push({
      label: "Volumen de confirmación",
      passed: ind.lastVolume >= threshold,
      detail: `Volumen ${ind.lastVolume.toFixed(0)} vs. ${cfg.volumeConfirmationRatio * 100}% del promedio 20d ${threshold.toFixed(0)}`,
      weight: WEIGHTS.volumeConfirmation,
    });
  } else {
    items.push({
      label: "Volumen de confirmación",
      passed: false,
      detail: "Volumen promedio aún no disponible",
      weight: WEIGHTS.volumeConfirmation,
    });
  }

  const score = items.filter((i) => i.passed).reduce((sum, i) => sum + (i.weight ?? 0), 0);

  let verdict: Verdict = "avoid";
  if (score >= MAX_SCORE * cfg.buyThresholdRatio) verdict = "buy";
  else if (score >= MAX_SCORE * cfg.watchThresholdRatio) verdict = "watch";

  return { items, score, maxScore: MAX_SCORE, verdict };
}

// Raised 70 -> 80 (2026-09-22): see DEFAULT_BUY_CONFIG.buyThresholdRatio's comment
// above — this is the other half of that combined, backtest-validated change.
// Exported (not just a default param) so the backtest can reference the live
// production value instead of duplicating it and risking drift.
export const DEFAULT_OVERBOUGHT_RSI_THRESHOLD = 80;
export const DEFAULT_NEAR_RESISTANCE_PCT = 1;

export function buildSellChecklist(
  ind: Indicators,
  entryPrice: number,
  stopLossPct = 10,
  feePct = 0.1,
  takeProfitPct = 20,
  overboughtRsiThreshold = DEFAULT_OVERBOUGHT_RSI_THRESHOLD,
  nearResistancePct = DEFAULT_NEAR_RESISTANCE_PCT,
): SellChecklistResult {
  const grossPnlPct = ((ind.price - entryPrice) / entryPrice) * 100;

  // Fee is paid on both legs: it raises the effective buy cost and lowers the effective sell proceeds.
  const cost = entryPrice * (1 + feePct / 100);
  const proceeds = ind.price * (1 - feePct / 100);
  const pnlPct = ((proceeds - cost) / cost) * 100;

  const overbought: ChecklistItem =
    ind.rsi14 !== null
      ? { label: "RSI(14) sobrecomprado", passed: ind.rsi14 > overboughtRsiThreshold, detail: `RSI ${ind.rsi14.toFixed(1)}` }
      : { label: "RSI(14) sobrecomprado", passed: false, detail: "RSI aún no disponible" };

  const distToResistance = ((ind.resistance20 - ind.price) / ind.resistance20) * 100;
  const nearResistance: ChecklistItem = {
    label: "Precio cerca de resistencia de 20 días",
    passed: distToResistance <= nearResistancePct,
    detail: `Resistencia ${ind.resistance20.toFixed(2)} (${distToResistance.toFixed(1)}% de distancia)`,
  };

  const stopLoss: ChecklistItem = {
    label: `Alerta de stop loss (-${stopLossPct}%)`,
    passed: pnlPct <= -stopLossPct,
    detail: `PnL neto actual: ${pnlPct.toFixed(1)}%`,
  };

  const takeProfit: ChecklistItem = {
    label: `Toma de ganancias (+${takeProfitPct}%)`,
    passed: pnlPct >= takeProfitPct,
    detail: `PnL neto actual: ${pnlPct.toFixed(1)}%`,
  };

  const trendBreak: ChecklistItem =
    ind.sma50 !== null
      ? {
          label: "Ruptura de tendencia de corto plazo (SMA50)",
          passed: ind.price < ind.sma50,
          detail: `Precio ${ind.price.toFixed(2)} vs. SMA50 ${ind.sma50.toFixed(2)}`,
        }
      : { label: "Ruptura de tendencia de corto plazo (SMA50)", passed: false, detail: "SMA50 aún no disponible" };

  // Position-sizing suggestion: stop loss is a hard rule (protect capital, full exit).
  // Everything else scales out progressively — the more signals confirm together,
  // the larger the suggested trim, capped at 100%.
  let suggestedSellPct = 0;
  const suggestedSellReasons: string[] = [];

  if (stopLoss.passed) {
    suggestedSellPct = 100;
    suggestedSellReasons.push(stopLoss.label);
  } else {
    if (takeProfit.passed) {
      suggestedSellPct += 50;
      suggestedSellReasons.push(takeProfit.label);
    }
    if (trendBreak.passed) {
      suggestedSellPct += 40;
      suggestedSellReasons.push(trendBreak.label);
    }
    if (overbought.passed && nearResistance.passed) {
      suggestedSellPct += 20;
      suggestedSellReasons.push("RSI sobrecomprado cerca de resistencia");
    }
    suggestedSellPct = Math.min(suggestedSellPct, 100);
  }

  return {
    pnlPct,
    grossPnlPct,
    overbought,
    nearResistance,
    stopLoss,
    takeProfit,
    trendBreak,
    suggestedSellPct,
    suggestedSellReasons,
  };
}
