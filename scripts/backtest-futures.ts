// Backtest of the futures paper-trading engine (src/lib/futuresEngine.ts) exactly as
// cf-worker-futures/worker.ts runs it — same trend filter, same entry score, same
// position management — walked over years of real hourly candles from Binance
// (Kraken's public API only gives the most recent 30 days of hourly data). Run with:
//   npx tsx scripts/backtest-futures.ts
import { computeIndicators } from "../src/lib/indicators";
import {
  PAIR_PARAMS,
  VARIANT_PARAMS,
  STARTING_CASH,
  emptyVariantState,
  type FuturesPair,
  type VariantKey,
  type VariantState,
} from "../src/lib/futuresTypes";
import {
  accrueFunding,
  canOpenPosition,
  closeSlice,
  computeEquity,
  evaluatePosition,
  newTrade,
  resetDayIfNeeded,
  scoreEntry,
  sizePosition,
  trendSide,
} from "../src/lib/futuresEngine";
import type { Candle } from "../src/lib/types";
import { getHistory } from "./binanceHistory";

const PAIRS: FuturesPair[] = ["ETHUSDT", "SOLUSDT"];
const VARIANT_KEYS: VariantKey[] = ["A-2x", "B-2x"];
const DAILY_WINDOW = 210;
const HOURLY_WINDOW = 210;

function dateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Trend is long-only now (trendSide never returns "short" — see futuresEngine.ts),
// so this is the only remaining experiment knob: RISK_PCT=1 npx tsx scripts/backtest-futures.ts
const RISK_PCT = process.env.RISK_PCT ? Number(process.env.RISK_PCT) : undefined;

async function main() {
  console.log("Descargando historia (Binance, cache local)...");
  const daily: Record<FuturesPair, Candle[]> = { ETHUSDT: await getHistory("ETHUSDT", "1d", 0), SOLUSDT: await getHistory("SOLUSDT", "1d", 0) };
  const hourly: Record<FuturesPair, Candle[]> = { ETHUSDT: await getHistory("ETHUSDT", "1h", 0), SOLUSDT: await getHistory("SOLUSDT", "1h", 0) };

  // Trend for day D always comes from the daily candle that closed on D-1 (never the
  // still-forming one) — same as getClosedDailyCandles in production.
  const trendByDate: Record<FuturesPair, Map<string, ReturnType<typeof trendSide>>> = { ETHUSDT: new Map(), SOLUSDT: new Map() };
  for (const pair of PAIRS) {
    const candles = daily[pair];
    for (let i = 199; i < candles.length - 1; i++) {
      const window = candles.slice(Math.max(0, i - (DAILY_WINDOW - 1)), i + 1);
      const ind = computeIndicators(window);
      const nextDay = dateStr(candles[i + 1].openTime);
      trendByDate[pair].set(nextDay, trendSide(ind));
    }
  }

  // Hourly indicators, precomputed with the same rolling window the Worker uses.
  const hourlyPoints: Record<FuturesPair, { t: number; ind: ReturnType<typeof computeIndicators> }[]> = { ETHUSDT: [], SOLUSDT: [] };
  for (const pair of PAIRS) {
    const candles = hourly[pair];
    for (let i = 209; i < candles.length; i++) {
      const window = candles.slice(Math.max(0, i - (HOURLY_WINDOW - 1)), i + 1);
      hourlyPoints[pair].push({ t: candles[i].openTime, ind: computeIndicators(window) });
    }
  }

  // Unified hourly timeline: every hour where both pairs have hourly data AND a daily
  // trend is known for that calendar date.
  const byTime: Record<FuturesPair, Map<number, ReturnType<typeof computeIndicators>>> = {
    ETHUSDT: new Map(hourlyPoints.ETHUSDT.map((p) => [p.t, p.ind])),
    SOLUSDT: new Map(hourlyPoints.SOLUSDT.map((p) => [p.t, p.ind])),
  };
  const allTimes = [...new Set([...byTime.ETHUSDT.keys()].filter((t) => byTime.SOLUSDT.has(t)))].sort((a, b) => a - b);
  const usableTimes = allTimes.filter((t) => PAIRS.every((p) => trendByDate[p].has(dateStr(t))));
  console.log(
    `Periodo del backtest (1h): ${new Date(usableTimes[0]).toISOString()} a ${new Date(usableTimes.at(-1)!).toISOString()} (${usableTimes.length} horas, ~${(usableTimes.length / 24 / 365).toFixed(1)} años)\n`,
  );

  const variants: Record<VariantKey, VariantState> = { "A-2x": emptyVariantState(), "B-2x": emptyVariantState() };
  const equityCurves: Record<VariantKey, { t: number; equity: number }[]> = { "A-2x": [], "B-2x": [] };
  const blockedReasons: Record<VariantKey, Record<string, number>> = { "A-2x": {}, "B-2x": {} };

  for (const t of usableTimes) {
    const dateOfT = dateStr(t);
    const prices: Partial<Record<FuturesPair, number>> = {};
    const trendsNow: Partial<Record<FuturesPair, ReturnType<typeof trendSide>>> = {};
    const inds: Partial<Record<FuturesPair, ReturnType<typeof computeIndicators>>> = {};
    for (const pair of PAIRS) {
      const ind = byTime[pair].get(t)!;
      inds[pair] = ind;
      prices[pair] = ind.price;
      trendsNow[pair] = trendByDate[pair].get(dateOfT)!;
    }

    for (const variantKey of VARIANT_KEYS) {
      const variant = variants[variantKey];
      const variantParams = VARIANT_PARAMS[variantKey];
      const equityNow = computeEquity(variant, prices);
      resetDayIfNeeded(variant, dateOfT, equityNow);

      for (const pair of PAIRS) {
        const pairParams = PAIR_PARAMS[pair];
        const price = prices[pair]!;
        const pos = variant.positions[pair];

        if (pos) {
          const funding = accrueFunding(pos, t);
          variant.cash -= funding;
          const action = evaluatePosition(pos, price, pairParams.stopPct, pairParams.targetPct, variantParams.exitStyle);
          if (action.type === "closeAll") {
            const { pnlUsd, marginReturned } = closeSlice(pos, price, pos.qtyRemaining);
            variant.cash += marginReturned + pnlUsd;
            variant.trades.push(newTrade(pair, pos, price, pos.qtyRemaining, pnlUsd, action.reason, t));
            delete variant.positions[pair];
          } else if (action.type === "closePartial") {
            const qtyToClose = pos.qtyRemaining * (action.pct / 100);
            const { pnlUsd, marginReturned } = closeSlice(pos, price, qtyToClose);
            variant.cash += marginReturned + pnlUsd;
            variant.trades.push(newTrade(pair, pos, price, qtyToClose, pnlUsd, action.reason, t));
            pos.qtyRemaining -= qtyToClose;
            pos.marginRemaining -= marginReturned;
            pos.partialTaken = true;
            pos.bestPrice = price;
          } else if (action.type === "updateTrail") {
            pos.bestPrice = action.bestPrice;
          }
          continue;
        }

        const trend = trendsNow[pair];
        if (!trend) continue;
        const entry = scoreEntry(inds[pair]!, trend);
        if (!entry.passed) continue;
        const gate = canOpenPosition(variant, equityNow);
        if (!gate.ok) {
          variant.blockedCount++;
          blockedReasons[variantKey][gate.reason!] = (blockedReasons[variantKey][gate.reason!] ?? 0) + 1;
          continue;
        }
        const sized = sizePosition(equityNow, pairParams.stopPct, variantParams.leverage, price, pairParams.minNotionalUsd, RISK_PCT);
        if (!sized) {
          variant.blockedCount++;
          blockedReasons[variantKey]["notional/margen insuficiente"] = (blockedReasons[variantKey]["notional/margen insuficiente"] ?? 0) + 1;
          continue;
        }
        variant.cash -= sized.margin;
        variant.positions[pair] = {
          side: trend,
          entryPrice: price,
          qty: sized.qty,
          qtyRemaining: sized.qty,
          margin: sized.margin,
          marginRemaining: sized.margin,
          leverage: variantParams.leverage,
          openedAt: new Date(t).toISOString(),
          partialTaken: false,
          bestPrice: price,
          lastFundingAt: new Date(t).toISOString(),
        };
      }
    }

    for (const variantKey of VARIANT_KEYS) {
      equityCurves[variantKey].push({ t, equity: computeEquity(variants[variantKey], prices) });
    }
  }

  report(variants, equityCurves, blockedReasons);
}

function report(
  variants: Record<VariantKey, VariantState>,
  equityCurves: Record<VariantKey, { t: number; equity: number }[]>,
  blockedReasons: Record<VariantKey, Record<string, number>>,
) {
  console.log("=".repeat(70));
  console.log("RESULTADO — simulación de futuros (ETH + SOL, long/short)");
  console.log("=".repeat(70));

  for (const key of VARIANT_KEYS) {
    const variant = variants[key];
    const curve = equityCurves[key];
    const finalEquity = curve.at(-1)!.equity;
    const totalReturnPct = ((finalEquity - STARTING_CASH) / STARTING_CASH) * 100;

    let peak = curve[0].equity;
    let maxDrawdownPct = 0;
    for (const { equity } of curve) {
      if (equity > peak) peak = equity;
      const dd = ((equity - peak) / peak) * 100;
      if (dd < maxDrawdownPct) maxDrawdownPct = dd;
    }

    const closed = variant.trades;
    const wins = closed.filter((t) => t.pnlUsd > 0);
    const realizedPnl = closed.reduce((sum, t) => sum + t.pnlUsd, 0);

    console.log(`\n--- ${key} ---`);
    console.log(`Capital: $${STARTING_CASH} -> $${finalEquity.toFixed(2)} (${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(1)}%)`);
    console.log(`Máxima caída: ${maxDrawdownPct.toFixed(1)}%`);
    console.log(`Cierres: ${closed.length} · aciertos: ${closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(0) : "-"}% (${wins.length}/${closed.length}) · PnL realizado: ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`);
    console.log(`Bloqueadas por frenos: ${variant.blockedCount} (${Object.entries(blockedReasons[key]).map(([r, c]) => `${r}: ${c}`).join(", ") || "-"})`);

    const byReason: Record<string, number> = {};
    for (const t of closed) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;
    console.log(`Motivos de cierre: ${Object.entries(byReason).map(([r, c]) => `${r}: ${c}`).join(", ") || "-"}`);

    console.log("Por año:");
    const years = [...new Set(curve.map((c) => new Date(c.t).getUTCFullYear()))];
    let prevEquity = STARTING_CASH;
    for (const year of years) {
      const yearPoints = curve.filter((c) => new Date(c.t).getUTCFullYear() === year);
      const endEquity = yearPoints.at(-1)!.equity;
      const yearReturn = ((endEquity - prevEquity) / prevEquity) * 100;
      const yearTrades = closed.filter((t) => new Date(t.closedAt).getUTCFullYear() === year);
      const yearWins = yearTrades.filter((t) => t.pnlUsd > 0);
      const winRate = yearTrades.length > 0 ? ((yearWins.length / yearTrades.length) * 100).toFixed(0) : "-";
      console.log(`  ${year}: ${yearReturn >= 0 ? "+" : ""}${yearReturn.toFixed(1)}% (${yearTrades.length} cierres, ${winRate}% aciertos)`);
      prevEquity = endEquity;
    }

    // Side breakdown (long vs short) and pair breakdown, plus longest losing streak.
    for (const side of ["long", "short"] as const) {
      const sideTrades = closed.filter((t) => t.side === side);
      const sideWins = sideTrades.filter((t) => t.pnlUsd > 0);
      const sidePnl = sideTrades.reduce((s, t) => s + t.pnlUsd, 0);
      console.log(
        `  ${side}: ${sideTrades.length} cierres, ${sideTrades.length > 0 ? ((sideWins.length / sideTrades.length) * 100).toFixed(0) : "-"}% aciertos, PnL ${sidePnl >= 0 ? "+" : ""}$${sidePnl.toFixed(2)}`,
      );
    }
    let streak = 0;
    let maxStreak = 0;
    for (const t of closed) {
      if (t.pnlUsd < 0) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else streak = 0;
    }
    console.log(`  racha perdedora más larga: ${maxStreak} cierres en negativo seguidos`);
  }

  console.log(`\nÚltimos cierres (todas las variantes):`);
  const allTrades = VARIANT_KEYS.flatMap((k) => variants[k].trades.map((t) => ({ ...t, variant: k })));
  for (const t of allTrades.slice(-10)) {
    console.log(`  ${t.closedAt.slice(0, 16)} ${t.variant} ${t.pair} ${t.side} @ $${t.exitPrice.toFixed(2)} (${t.pnlUsd >= 0 ? "+" : ""}$${t.pnlUsd.toFixed(2)}) — ${t.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
