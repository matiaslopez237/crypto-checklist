import type { Pair } from "./types";

export interface StoredPosition {
  avgBuyPrice: number | null;
  qty: number;
  stopLossPct: number;
  takeProfitPct: number;
  feePct: number;
}

export type PositionsFile = Partial<Record<Pair, StoredPosition>>;

const PAIR_ALIASES: Record<string, Pair> = { BTC: "BTCUSDT", BTCUSDT: "BTCUSDT", ETH: "ETHUSDT", ETHUSDT: "ETHUSDT" };
export const PAIR_LABELS: Record<Pair, string> = { BTCUSDT: "BTC/USDT", ETHUSDT: "ETH/USDT" };
const DEFAULT_THRESHOLDS = { stopLossPct: 10, takeProfitPct: 20, feePct: 0.1 };

const HELP_TEXT =
  "Comandos disponibles:\n" +
  "/comprar BTC 65000 500 — registra una compra (par, precio, monto en USDT)\n" +
  "/vender BTC 65000 500 — registra una venta\n" +
  "/posicion — muestra tu posición actual\n" +
  "/reset BTC — limpia la posición de ese par";

function normalizePair(raw: string | undefined): Pair | null {
  return raw ? (PAIR_ALIASES[raw.toUpperCase()] ?? null) : null;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Average-cost method, same as computeOpenPosition in journalStats.ts — applied
// incrementally since positions.json only keeps the running totals, not a trade log.
function applyBuy(pos: StoredPosition, price: number, amountUsdt: number): StoredPosition {
  const existingQty = pos.qty || 0;
  const existingCost = pos.avgBuyPrice ? existingQty * pos.avgBuyPrice : 0;
  const newQty = amountUsdt / price;
  const totalQty = existingQty + newQty;
  const totalCost = existingCost + amountUsdt;
  return { ...pos, qty: totalQty, avgBuyPrice: totalQty > 0 ? totalCost / totalQty : null };
}

function applySell(pos: StoredPosition, price: number, amountUsdt: number): StoredPosition {
  const soldQty = amountUsdt / price;
  const newQty = Math.max(0, (pos.qty || 0) - soldQty);
  return { ...pos, qty: newQty, avgBuyPrice: newQty > 0 ? pos.avgBuyPrice : null };
}

function positionSummary(positions: PositionsFile): string {
  return (Object.keys(PAIR_LABELS) as Pair[])
    .map((pair) => {
      const pos = positions[pair];
      if (!pos || !pos.avgBuyPrice || pos.qty <= 0) return `${PAIR_LABELS[pair]}: sin posición`;
      return `${PAIR_LABELS[pair]}: ${pos.qty.toFixed(6)} @ $${fmt(pos.avgBuyPrice)} promedio`;
    })
    .join("\n");
}

export interface CommandResult {
  reply: string;
  changed?: boolean;
}

// Mutates `positions` in place when the command changes something (mirrors process-commands.mjs's
// prior behavior) and returns the reply text to send back plus whether a write is needed.
export function handleTelegramCommand(text: string, positions: PositionsFile): CommandResult {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/^\//, "").replace(/@.*$/, "");

  if (cmd === "comprar" || cmd === "buy") {
    const pair = normalizePair(parts[1]);
    const price = Number(parts[2]);
    const amountUsdt = Number(parts[3]);
    if (!pair || !price || !amountUsdt) return { reply: `No entendí. Uso: /comprar BTC 65000 500\n\n${HELP_TEXT}` };

    const existing = positions[pair] ?? { ...DEFAULT_THRESHOLDS, avgBuyPrice: null, qty: 0 };
    positions[pair] = applyBuy(existing, price, amountUsdt);
    const p = positions[pair] as StoredPosition;
    return {
      changed: true,
      reply:
        `✅ Compra registrada: ${PAIR_LABELS[pair]} @ $${fmt(price)} ($${fmt(amountUsdt)})\n` +
        `Posición: ${p.qty.toFixed(6)} @ $${fmt(p.avgBuyPrice as number)} promedio`,
    };
  }

  if (cmd === "vender" || cmd === "sell") {
    const pair = normalizePair(parts[1]);
    const price = Number(parts[2]);
    const amountUsdt = Number(parts[3]);
    if (!pair || !price || !amountUsdt) return { reply: `No entendí. Uso: /vender BTC 65000 500\n\n${HELP_TEXT}` };

    const existing = positions[pair] ?? { ...DEFAULT_THRESHOLDS, avgBuyPrice: null, qty: 0 };
    positions[pair] = applySell(existing, price, amountUsdt);
    const p = positions[pair] as StoredPosition;
    return {
      changed: true,
      reply:
        `✅ Venta registrada: ${PAIR_LABELS[pair]} @ $${fmt(price)} ($${fmt(amountUsdt)})\n` +
        `Posición restante: ${p.qty.toFixed(6)}${p.qty > 0 ? ` @ $${fmt(p.avgBuyPrice as number)} promedio` : ""}`,
    };
  }

  if (cmd === "posicion" || cmd === "position" || cmd === "status") {
    return { reply: positionSummary(positions) };
  }

  if (cmd === "reset") {
    const pair = normalizePair(parts[1]);
    if (!pair) return { reply: "Uso: /reset BTC" };
    const existing = positions[pair] ?? { ...DEFAULT_THRESHOLDS, avgBuyPrice: null, qty: 0 };
    positions[pair] = { ...existing, avgBuyPrice: null, qty: 0 };
    return { changed: true, reply: `✅ Posición de ${PAIR_LABELS[pair]} reseteada.` };
  }

  return { reply: HELP_TEXT };
}
