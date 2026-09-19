import type { Pair } from "./types";
import { PAIR_LABELS, fmt } from "./telegramCommands";

// Paper-trading ledger: simulates acting on the bot's own signals (buy zone
// entries/improvements, sell suggestions) with fake money, so the strategy can
// be evaluated before ever risking a real Binance sub-account on it. Never
// notifies Telegram — purely recorded for later review via /papel.

export const PAPER_STARTING_CASH = 15;
const BUY_ALLOCATION_PCT = 20; // % of current cash spent per simulated buy signal
export const PAPER_THRESHOLDS = { stopLossPct: 10, takeProfitPct: 3, feePct: 0.1 };

export interface PaperPosition {
  qty: number;
  avgBuyPrice: number | null;
  stopLossAlerted: boolean;
  takeProfitAlerted: boolean;
  technicalSellAlerted: boolean;
  trendBreakAlerted: boolean;
}

export interface PaperTrade {
  date: string; // ISO timestamp
  pair: Pair;
  side: "buy" | "sell";
  price: number;
  amountUsdt: number;
  reason: string;
}

export interface PaperPortfolio {
  cashUsdt: number;
  positions: Partial<Record<Pair, PaperPosition>>;
  trades: PaperTrade[];
}

export function emptyPaperPosition(): PaperPosition {
  return { qty: 0, avgBuyPrice: null, stopLossAlerted: false, takeProfitAlerted: false, technicalSellAlerted: false, trendBreakAlerted: false };
}

export function emptyPaperPortfolio(): PaperPortfolio {
  return { cashUsdt: PAPER_STARTING_CASH, positions: {}, trades: [] };
}

export function applyPaperBuy(portfolio: PaperPortfolio, pair: Pair, price: number, reason: string): void {
  const amountUsdt = portfolio.cashUsdt * (BUY_ALLOCATION_PCT / 100);
  if (amountUsdt < 1) return; // not enough fake cash left to bother

  const existing = portfolio.positions[pair] ?? emptyPaperPosition();
  const existingCost = existing.avgBuyPrice ? existing.qty * existing.avgBuyPrice : 0;
  // Exchange fee comes out of what was spent, so fewer units are received. avgBuyPrice
  // stays the raw execution price (the net-PnL formula adds the entry fee itself).
  const newQty = (amountUsdt * (1 - PAPER_THRESHOLDS.feePct / 100)) / price;
  const totalQty = existing.qty + newQty;

  portfolio.positions[pair] = { ...existing, qty: totalQty, avgBuyPrice: (existingCost + newQty * price) / totalQty };
  portfolio.cashUsdt -= amountUsdt;
  portfolio.trades.push({ date: new Date().toISOString(), pair, side: "buy", price, amountUsdt, reason });
}

export function applyPaperSell(portfolio: PaperPortfolio, pair: Pair, price: number, sellPct: number, reason: string): void {
  const pos = portfolio.positions[pair];
  if (!pos || pos.qty <= 0) return;

  const qtyToSell = pos.qty * (sellPct / 100);
  const proceeds = qtyToSell * price * (1 - PAPER_THRESHOLDS.feePct / 100);
  const newQty = pos.qty - qtyToSell;

  portfolio.positions[pair] = { ...pos, qty: newQty, avgBuyPrice: newQty > 1e-12 ? pos.avgBuyPrice : null };
  portfolio.cashUsdt += proceeds;
  portfolio.trades.push({ date: new Date().toISOString(), pair, side: "sell", price, amountUsdt: proceeds, reason });
}

export function buildPaperSummary(portfolio: PaperPortfolio, prices: Partial<Record<Pair, number>>): string {
  const lines: string[] = [];
  let totalValue = portfolio.cashUsdt;

  for (const pair of Object.keys(PAIR_LABELS) as Pair[]) {
    const pos = portfolio.positions[pair];
    if (!pos || pos.qty <= 0) continue;
    const price = prices[pair];
    const value = price ? pos.qty * price : null;
    if (value !== null) totalValue += value;
    const pnlText =
      price && pos.avgBuyPrice
        ? ` (${(((price - pos.avgBuyPrice) / pos.avgBuyPrice) * 100 >= 0 ? "+" : "") + (((price - pos.avgBuyPrice) / pos.avgBuyPrice) * 100).toFixed(1)}%)`
        : "";
    lines.push(`${PAIR_LABELS[pair]}: ${pos.qty.toFixed(6)} @ $${fmt(pos.avgBuyPrice ?? 0)} promedio${pnlText}`);
  }

  const pctReturn = ((totalValue - PAPER_STARTING_CASH) / PAPER_STARTING_CASH) * 100;
  const header =
    `📝 <b>Simulación (papel)</b>\n` +
    `Valor total: $${fmt(totalValue)} de $${fmt(PAPER_STARTING_CASH)} inicial (${pctReturn >= 0 ? "+" : ""}${pctReturn.toFixed(1)}%)\n` +
    `Efectivo: $${fmt(portfolio.cashUsdt)}\n` +
    `Operaciones simuladas: ${portfolio.trades.length}`;

  return lines.length > 0 ? `${header}\n\nPosiciones:\n${lines.join("\n")}` : header;
}
