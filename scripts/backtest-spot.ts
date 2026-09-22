// Backtest of the spot strategy exactly as it runs in production: same checklist,
// same buy-zone hysteresis, same paper-trading engine (src/lib/*) — just walked over
// years of real daily candles instead of live 5/15-minute cron ticks. Run with:
//   npx tsx scripts/backtest-spot.ts
import { computeIndicators } from "../src/lib/indicators";
import { buildBuyChecklist, buildSellChecklist } from "../src/lib/checklist";
import { evaluateBuyZone, markIfActive, rearmConditions, type BuyZoneState } from "../src/lib/spotStrategy";
import {
  applyPaperBuy,
  applyPaperSell,
  emptyPaperPortfolio,
  emptyPaperPosition,
  PAPER_STARTING_CASH,
  PAPER_THRESHOLDS,
  type PaperPortfolio,
} from "../src/lib/paperTrading";
import type { Candle, Pair } from "../src/lib/types";
import { getHistory } from "./binanceHistory";

const PAIRS: Pair[] = ["BTCUSDT", "ETHUSDT"];
const WINDOW = 210; // same rolling window the live Worker feeds computeIndicators

// Override the paper-trading take-profit for experimentation without touching
// production: TAKE_PROFIT_PCT=6 npx tsx scripts/backtest-spot.ts
const THRESHOLDS = { ...PAPER_THRESHOLDS, takeProfitPct: process.env.TAKE_PROFIT_PCT ? Number(process.env.TAKE_PROFIT_PCT) : PAPER_THRESHOLDS.takeProfitPct };

interface TradeRecord {
  date: string;
  pair: Pair;
  side: "buy" | "sell";
  price: number;
  pnlPct: number | null; // only set for sells
  reason: string;
}

interface AlertState extends BuyZoneState {
  stopLossAlerted: boolean;
  takeProfitAlerted: boolean;
  technicalSellAlerted: boolean;
  trendBreakAlerted: boolean;
}

function emptyAlertState(): AlertState {
  return { lastVerdict: null, lastNotifiedBuyScore: null, stopLossAlerted: false, takeProfitAlerted: false, technicalSellAlerted: false, trendBreakAlerted: false };
}

function dateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  console.log("Descargando historia diaria (Binance, cache local)...");
  const rawHistory: Record<Pair, Candle[]> = {
    BTCUSDT: await getHistory("BTCUSDT", "1d", 0),
    ETHUSDT: await getHistory("ETHUSDT", "1d", 0),
  };

  // Precompute each pair's indicator series using the same rolling window the Worker
  // uses, then find the date range where both pairs have enough history (day 200+).
  const indicatorsByDate: Record<Pair, Map<string, ReturnType<typeof computeIndicators>>> = { BTCUSDT: new Map(), ETHUSDT: new Map() };
  const priceByDate: Record<Pair, Map<string, number>> = { BTCUSDT: new Map(), ETHUSDT: new Map() };
  for (const pair of PAIRS) {
    const candles = rawHistory[pair];
    for (let i = 199; i < candles.length; i++) {
      const window = candles.slice(Math.max(0, i - (WINDOW - 1)), i + 1);
      const ind = computeIndicators(window);
      const d = dateStr(candles[i].openTime);
      indicatorsByDate[pair].set(d, ind);
      priceByDate[pair].set(d, candles[i].close);
    }
  }

  const commonDates = [...indicatorsByDate.BTCUSDT.keys()].filter((d) => indicatorsByDate.ETHUSDT.has(d)).sort();
  console.log(`Periodo del backtest: ${commonDates[0]} a ${commonDates.at(-1)} (${commonDates.length} dias)\n`);

  const portfolio: PaperPortfolio = emptyPaperPortfolio();
  const states: Record<Pair, AlertState> = { BTCUSDT: emptyAlertState(), ETHUSDT: emptyAlertState() };
  const trades: TradeRecord[] = [];
  const equityCurve: { date: string; equity: number }[] = [];

  for (const date of commonDates) {
    for (const pair of PAIRS) {
      const ind = indicatorsByDate[pair].get(date)!;
      const buyResult = buildBuyChecklist(ind);
      const state = states[pair];

      const { enteredBuyZoneNow, buyZoneImprovedEnough } = evaluateBuyZone(state, buyResult);
      if (enteredBuyZoneNow || buyZoneImprovedEnough) {
        const cashBefore = portfolio.cashUsdt;
        applyPaperBuy(portfolio, pair, ind.price, enteredBuyZoneNow ? "entrada en zona de compra" : "mejora de zona de compra");
        if (portfolio.cashUsdt !== cashBefore) trades.push({ date, pair, side: "buy", price: ind.price, pnlPct: null, reason: enteredBuyZoneNow ? "entrada" : "mejora" });
      }

      const paperPos = portfolio.positions[pair];
      if (paperPos && paperPos.qty > 0 && paperPos.avgBuyPrice) {
        const paperSell = buildSellChecklist(ind, paperPos.avgBuyPrice, THRESHOLDS.stopLossPct, THRESHOLDS.feePct, THRESHOLDS.takeProfitPct);
        const paperRearm = rearmConditions(ind, paperSell.pnlPct, THRESHOLDS.stopLossPct, THRESHOLDS.takeProfitPct);
        const stopLossNew = markIfActive(paperPos, "stopLossAlerted", paperSell.stopLoss.passed, paperRearm.stopLoss);
        const takeProfitNew = markIfActive(paperPos, "takeProfitAlerted", paperSell.takeProfit.passed, paperRearm.takeProfit);
        const technicalNew = markIfActive(paperPos, "technicalSellAlerted", paperSell.overbought.passed && paperSell.nearResistance.passed, paperRearm.technical);
        const trendBreakNew = markIfActive(paperPos, "trendBreakAlerted", paperSell.trendBreak.passed, paperRearm.trendBreak);

        if (stopLossNew) {
          applyPaperSell(portfolio, pair, ind.price, 100, "stop loss");
          trades.push({ date, pair, side: "sell", price: ind.price, pnlPct: paperSell.pnlPct, reason: "stop loss" });
        } else if ((takeProfitNew || technicalNew || trendBreakNew) && paperSell.suggestedSellPct > 0) {
          const reasons = [takeProfitNew && "take profit", technicalNew && "señal técnica", trendBreakNew && "ruptura de tendencia"].filter(Boolean).join(" + ");
          applyPaperSell(portfolio, pair, ind.price, paperSell.suggestedSellPct, reasons);
          trades.push({ date, pair, side: "sell", price: ind.price, pnlPct: paperSell.pnlPct, reason: reasons });
        }
      } else if (portfolio.positions[pair]) {
        portfolio.positions[pair] = emptyPaperPosition();
      }
    }

    let equity = portfolio.cashUsdt;
    for (const pair of PAIRS) {
      const pos = portfolio.positions[pair];
      if (pos && pos.qty > 0) equity += pos.qty * priceByDate[pair].get(date)!;
    }
    equityCurve.push({ date, equity });
  }

  report(commonDates, portfolio, trades, equityCurve, priceByDate);
}

function report(
  dates: string[],
  portfolio: PaperPortfolio,
  trades: TradeRecord[],
  equityCurve: { date: string; equity: number }[],
  priceByDate: Record<Pair, Map<string, number>>,
) {
  const finalEquity = equityCurve.at(-1)!.equity;
  const totalReturnPct = ((finalEquity - PAPER_STARTING_CASH) / PAPER_STARTING_CASH) * 100;

  let peak = equityCurve[0].equity;
  let maxDrawdownPct = 0;
  for (const { equity } of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = ((equity - peak) / peak) * 100;
    if (dd < maxDrawdownPct) maxDrawdownPct = dd;
  }

  const sells = trades.filter((t) => t.side === "sell");
  const wins = sells.filter((t) => (t.pnlPct ?? 0) > 0);

  console.log("=".repeat(60));
  console.log("RESULTADO — estrategia spot (checklist compra/venta actual)");
  console.log("=".repeat(60));
  console.log(`Capital inicial: $${PAPER_STARTING_CASH} -> final: $${finalEquity.toFixed(2)} (${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(1)}%)`);
  console.log(`Máxima caída (drawdown): ${maxDrawdownPct.toFixed(1)}%`);
  console.log(`Operaciones: ${trades.length} (${trades.filter((t) => t.side === "buy").length} compras, ${sells.length} ventas)`);
  console.log(`Aciertos en ventas: ${sells.length > 0 ? ((wins.length / sells.length) * 100).toFixed(0) : "-"}% (${wins.length}/${sells.length})`);

  // Buy & hold comparison: same starting cash split 50/50 at day 1, held to the end —
  // tracked day by day too, so its own max drawdown is a fair comparison.
  const firstDate = dates[0];
  const startPrices = Object.fromEntries(PAIRS.map((p) => [p, priceByDate[p].get(firstDate)!])) as Record<Pair, number>;
  let bhPeak = PAPER_STARTING_CASH;
  let bhMaxDrawdownPct = 0;
  let bhValue = PAPER_STARTING_CASH;
  for (const date of dates) {
    bhValue = PAIRS.reduce((sum, p) => sum + (PAPER_STARTING_CASH / PAIRS.length) * (priceByDate[p].get(date)! / startPrices[p]), 0);
    if (bhValue > bhPeak) bhPeak = bhValue;
    const dd = ((bhValue - bhPeak) / bhPeak) * 100;
    if (dd < bhMaxDrawdownPct) bhMaxDrawdownPct = dd;
  }
  const bhReturnPct = ((bhValue - PAPER_STARTING_CASH) / PAPER_STARTING_CASH) * 100;
  console.log(`Comparación — comprar y guardar (50/50 BTC/ETH, mismo período): ${bhReturnPct >= 0 ? "+" : ""}${bhReturnPct.toFixed(1)}%, máxima caída ${bhMaxDrawdownPct.toFixed(1)}%`);

  console.log("\nPor año:");
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))];
  for (const year of years) {
    const yearPoints = equityCurve.filter((e) => e.date.startsWith(year));
    if (yearPoints.length === 0) continue;
    const startEquity = year === years[0] ? PAPER_STARTING_CASH : equityCurve[equityCurve.findIndex((e) => e.date === yearPoints[0].date) - 1].equity;
    const endEquity = yearPoints.at(-1)!.equity;
    const yearReturn = ((endEquity - startEquity) / startEquity) * 100;
    const yearTrades = trades.filter((t) => t.date.startsWith(year)).length;
    console.log(`  ${year}: ${yearReturn >= 0 ? "+" : ""}${yearReturn.toFixed(1)}% (${yearTrades} operaciones)`);
  }

  console.log("\nÚltimas 10 operaciones:");
  for (const t of trades.slice(-10)) {
    const pnlText = t.pnlPct !== null ? ` (${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%)` : "";
    console.log(`  ${t.date} ${t.pair} ${t.side} @ $${t.price.toFixed(2)}${pnlText} — ${t.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
