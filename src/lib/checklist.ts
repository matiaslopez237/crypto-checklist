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

export function buildBuyChecklist(ind: Indicators): BuyChecklistResult {
  const items: ChecklistItem[] = [];

  if (ind.sma200 !== null) {
    const threshold = ind.sma200 * 0.97;
    items.push({
      label: "Contexto de fondo no bajista (SMA200)",
      passed: ind.price >= threshold,
      detail: `Precio ${ind.price.toFixed(2)} vs. SMA200*0.97 ${threshold.toFixed(2)}`,
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
    const threshold = ind.sma200 * 0.95;
    items.push({
      label: "Tendencia de mediano plazo sana (SMA50)",
      passed: ind.sma50 >= threshold,
      detail: `SMA50 ${ind.sma50.toFixed(2)} vs. SMA200*0.95 ${threshold.toFixed(2)}`,
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
    passed: distToSupport <= 4,
    detail: `${distToSupport.toFixed(1)}% sobre el soporte (${ind.support20.toFixed(2)})`,
    weight: WEIGHTS.nearSupport,
  });

  if (ind.rsi14 !== null) {
    items.push({
      label: "RSI(14) sin sobrecompra",
      passed: ind.rsi14 < 70,
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
      passed: ind.change3d <= 12,
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
    passed: distToResistance >= 5,
    detail: `${distToResistance.toFixed(1)}% de recorrido hasta ${ind.resistance20.toFixed(2)}`,
    weight: WEIGHTS.roomToResistance,
  });

  if (ind.avgVolume20 !== null) {
    const threshold = ind.avgVolume20 * 0.8;
    items.push({
      label: "Volumen de confirmación",
      passed: ind.lastVolume >= threshold,
      detail: `Volumen ${ind.lastVolume.toFixed(0)} vs. 80% del promedio 20d ${threshold.toFixed(0)}`,
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
  if (score >= MAX_SCORE * 0.75) verdict = "buy";
  else if (score >= MAX_SCORE * 0.5) verdict = "watch";

  return { items, score, maxScore: MAX_SCORE, verdict };
}

export function buildSellChecklist(
  ind: Indicators,
  entryPrice: number,
  stopLossPct = 10,
  feePct = 0.1,
  takeProfitPct = 20,
): SellChecklistResult {
  const grossPnlPct = ((ind.price - entryPrice) / entryPrice) * 100;

  // Fee is paid on both legs: it raises the effective buy cost and lowers the effective sell proceeds.
  const cost = entryPrice * (1 + feePct / 100);
  const proceeds = ind.price * (1 - feePct / 100);
  const pnlPct = ((proceeds - cost) / cost) * 100;

  const overbought: ChecklistItem =
    ind.rsi14 !== null
      ? { label: "RSI(14) sobrecomprado", passed: ind.rsi14 > 70, detail: `RSI ${ind.rsi14.toFixed(1)}` }
      : { label: "RSI(14) sobrecomprado", passed: false, detail: "RSI aún no disponible" };

  const distToResistance = ((ind.resistance20 - ind.price) / ind.resistance20) * 100;
  const nearResistance: ChecklistItem = {
    label: "Precio cerca de resistencia de 20 días",
    passed: distToResistance <= 1,
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
