export type Pair = "BTCUSDT" | "ETHUSDT";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Indicators {
  price: number;
  sma200: number | null;
  sma50: number | null;
  rsi14: number | null;
  support20: number;
  resistance20: number;
  change3d: number | null;
  lastVolume: number;
  avgVolume20: number | null;
}

export type Verdict = "buy" | "watch" | "avoid";

export interface ChecklistItem {
  label: string;
  passed: boolean;
  detail: string;
  // Only set for buy-checklist items, where each condition contributes proportionally to the score.
  weight?: number;
}

export interface BuyChecklistResult {
  items: ChecklistItem[];
  score: number;
  maxScore: number;
  verdict: Verdict;
}

export interface SellChecklistResult {
  pnlPct: number;
  grossPnlPct: number;
  overbought: ChecklistItem;
  nearResistance: ChecklistItem;
  stopLoss: ChecklistItem;
  takeProfit: ChecklistItem;
  trendBreak: ChecklistItem;
  suggestedSellPct: number;
  suggestedSellReasons: string[];
}

export interface JournalEntry {
  id: string;
  pair: Pair;
  side: "buy" | "sell";
  date: string;
  price: number;
  amountUsdt: number | null;
  reason: string;
  result: string;
}
