import type { JournalEntry } from "./types";

export interface AveragePriceResult {
  avgPrice: number | null;
  totalUsdt: number;
  totalQty: number;
  countWithAmount: number;
  countMissingAmount: number;
}

function averageForSide(entries: JournalEntry[], side: "buy" | "sell"): AveragePriceResult {
  const sideEntries = entries.filter((e) => e.side === side);
  const withAmount = sideEntries.filter((e) => e.amountUsdt != null && e.amountUsdt > 0);

  const totalUsdt = withAmount.reduce((sum, e) => sum + (e.amountUsdt as number), 0);
  const totalQty = withAmount.reduce((sum, e) => sum + (e.amountUsdt as number) / e.price, 0);

  return {
    avgPrice: totalQty > 0 ? totalUsdt / totalQty : null,
    totalUsdt,
    totalQty,
    countWithAmount: withAmount.length,
    countMissingAmount: sideEntries.length - withAmount.length,
  };
}

export function computeAveragePrices(entries: JournalEntry[]) {
  return {
    buy: averageForSide(entries, "buy"),
    sell: averageForSide(entries, "sell"),
  };
}

export interface OpenPosition {
  qty: number;
  avgBuyPrice: number | null;
  costUsdt: number;
  missingAmountCount: number;
}

// Net position still held: total bought minus total sold (in coin units), cost
// basis taken at the average price of the buys (average-cost method, no lot tracking).
export function computeOpenPosition(entries: JournalEntry[]): OpenPosition {
  const { buy, sell } = computeAveragePrices(entries);
  const qty = Math.max(0, buy.totalQty - sell.totalQty);
  return {
    qty,
    avgBuyPrice: buy.avgPrice,
    costUsdt: buy.avgPrice !== null ? qty * buy.avgPrice : 0,
    missingAmountCount: buy.countMissingAmount + sell.countMissingAmount,
  };
}
