// Runs frequently (GitHub Actions, every ~10min) to let you update your position
// from your phone by messaging the Telegram bot. Local test: node monitor/process-commands.mjs
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { sendTelegram, getUpdatesFromOwner, isConfigured } from "./telegram.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIONS_PATH = path.join(__dirname, "positions.json");
const OFFSET_PATH = path.join(__dirname, "telegram-offset.json");

const PAIR_ALIASES = { BTC: "BTCUSDT", BTCUSDT: "BTCUSDT", ETH: "ETHUSDT", ETHUSDT: "ETHUSDT" };
const PAIR_LABELS = { BTCUSDT: "BTC/USDT", ETHUSDT: "ETH/USDT" };
const DEFAULT_THRESHOLDS = { stopLossPct: 10, takeProfitPct: 20, feePct: 0.1 };

const HELP_TEXT =
  "Comandos disponibles:\n" +
  "/comprar BTC 65000 500 — registra una compra (par, precio, monto en USDT)\n" +
  "/vender BTC 65000 500 — registra una venta\n" +
  "/posicion — muestra tu posición actual\n" +
  "/reset BTC — limpia la posición de ese par";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function normalizePair(raw) {
  return PAIR_ALIASES[raw?.toUpperCase()] ?? null;
}

function fmt(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Average-cost method, same as computeOpenPosition in src/lib/journalStats.ts —
// but applied incrementally since positions.json only keeps the running totals.
function applyBuy(pos, price, amountUsdt) {
  const existingQty = pos.qty || 0;
  const existingCost = pos.avgBuyPrice ? existingQty * pos.avgBuyPrice : 0;
  const newQty = amountUsdt / price;
  const totalQty = existingQty + newQty;
  const totalCost = existingCost + amountUsdt;
  return { ...pos, qty: totalQty, avgBuyPrice: totalQty > 0 ? totalCost / totalQty : null };
}

function applySell(pos, price, amountUsdt) {
  const soldQty = amountUsdt / price;
  const newQty = Math.max(0, (pos.qty || 0) - soldQty);
  return { ...pos, qty: newQty, avgBuyPrice: newQty > 0 ? pos.avgBuyPrice : null };
}

function positionSummary(positions) {
  return Object.entries(PAIR_LABELS)
    .map(([pair, label]) => {
      const pos = positions[pair];
      if (!pos || !pos.avgBuyPrice || pos.qty <= 0) return `${label}: sin posición`;
      return `${label}: ${pos.qty.toFixed(6)} @ $${fmt(pos.avgBuyPrice)} promedio`;
    })
    .join("\n");
}

function handleCommand(text, positions) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/^\//, "").replace(/@.*$/, "");

  if (cmd === "comprar" || cmd === "buy") {
    const pair = normalizePair(parts[1]);
    const price = Number(parts[2]);
    const amountUsdt = Number(parts[3]);
    if (!pair || !price || !amountUsdt) return { reply: `No entendí. Uso: /comprar BTC 65000 500\n\n${HELP_TEXT}` };

    const existing = positions[pair] ?? { ...DEFAULT_THRESHOLDS, avgBuyPrice: null, qty: 0 };
    positions[pair] = applyBuy(existing, price, amountUsdt);
    const p = positions[pair];
    return {
      changed: true,
      reply:
        `✅ Compra registrada: ${PAIR_LABELS[pair]} @ $${fmt(price)} ($${fmt(amountUsdt)})\n` +
        `Posición: ${p.qty.toFixed(6)} @ $${fmt(p.avgBuyPrice)} promedio`,
    };
  }

  if (cmd === "vender" || cmd === "sell") {
    const pair = normalizePair(parts[1]);
    const price = Number(parts[2]);
    const amountUsdt = Number(parts[3]);
    if (!pair || !price || !amountUsdt) return { reply: `No entendí. Uso: /vender BTC 65000 500\n\n${HELP_TEXT}` };

    const existing = positions[pair] ?? { ...DEFAULT_THRESHOLDS, avgBuyPrice: null, qty: 0 };
    positions[pair] = applySell(existing, price, amountUsdt);
    const p = positions[pair];
    return {
      changed: true,
      reply:
        `✅ Venta registrada: ${PAIR_LABELS[pair]} @ $${fmt(price)} ($${fmt(amountUsdt)})\n` +
        `Posición restante: ${p.qty.toFixed(6)}${p.qty > 0 ? ` @ $${fmt(p.avgBuyPrice)} promedio` : ""}`,
    };
  }

  if (cmd === "posicion" || cmd === "position" || cmd === "status") {
    return { reply: positionSummary(positions) };
  }

  if (cmd === "reset") {
    const pair = normalizePair(parts[1]);
    if (!pair) return { reply: "Uso: /reset BTC" };
    const existing = positions[pair] ?? { ...DEFAULT_THRESHOLDS };
    positions[pair] = { ...existing, avgBuyPrice: null, qty: 0 };
    return { changed: true, reply: `✅ Posición de ${PAIR_LABELS[pair]} reseteada.` };
  }

  return { reply: HELP_TEXT };
}

async function main() {
  if (!isConfigured()) {
    console.log("Telegram no configurado, nada que hacer.");
    return;
  }

  const offsetData = await readJson(OFFSET_PATH, { offset: 0 });
  const { updates, nextOffset } = await getUpdatesFromOwner(offsetData.offset);

  let changed = false;
  if (updates.length > 0) {
    const positions = await readJson(POSITIONS_PATH, {});
    for (const text of updates) {
      const result = handleCommand(text, positions);
      if (result.changed) changed = true;
      await sendTelegram(result.reply);
    }
    if (changed) {
      await writeFile(POSITIONS_PATH, JSON.stringify(positions, null, 2) + "\n");
    }
  }

  if (nextOffset !== offsetData.offset) {
    await writeFile(OFFSET_PATH, JSON.stringify({ offset: nextOffset }, null, 2) + "\n");
  }
}

main();
