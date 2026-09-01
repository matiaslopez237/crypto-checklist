// Runs on a schedule (GitHub Actions) to watch BTC/ETH 24/7 and notify Telegram
// when the buy/sell checklists from src/lib flip into an actionable state.
// Local test: node monitor/check.mjs   (no TELEGRAM_* env vars => prints instead of sending)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fetchDailyKlines } from "../src/lib/binance.ts";
import { computeIndicators } from "../src/lib/indicators.ts";
import { buildBuyChecklist, buildSellChecklist } from "../src/lib/checklist.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIONS_PATH = path.join(__dirname, "positions.json");
const STATE_PATH = path.join(__dirname, "state.json");

const PAIR_LABELS = { BTCUSDT: "BTC/USDT", ETHUSDT: "ETH/USDT" };

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf-8"));
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[dry-run, no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID set] would send:\n" + text);
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

async function checkPair(pair, positions, state) {
  const label = PAIR_LABELS[pair];
  const candles = await fetchDailyKlines(pair, 210);
  const ind = computeIndicators(candles);
  const buyResult = buildBuyChecklist(ind);
  const pairState = state[pair];

  // Buy signal: notify only on the transition into the green zone, not every run it stays there.
  if (buyResult.verdict === "buy" && pairState.lastVerdict !== "buy") {
    const passed = buyResult.items.filter((i) => i.passed).map((i) => `• ${i.label}`);
    await sendTelegram(
      `🟢 <b>${label} entró en zona de compra</b>\n` +
        `Score: ${buyResult.score}/${buyResult.maxScore}\n` +
        `Precio: $${ind.price.toFixed(2)}\n\n` +
        `Cumple:\n${passed.join("\n")}`,
    );
  }
  pairState.lastVerdict = buyResult.verdict;

  // Sell signals: only if a position is configured for this pair.
  const pos = positions[pair];
  if (pos && pos.avgBuyPrice && pos.qty > 0) {
    const sellResult = buildSellChecklist(ind, pos.avgBuyPrice, pos.stopLossPct, pos.feePct, pos.takeProfitPct);

    await handleAlert(pairState, "stopLossAlerted", sellResult.stopLoss.passed, async () =>
      sendTelegram(
        `🔴 <b>${label}: alerta de stop loss</b>\n` +
          `PnL neto: ${sellResult.pnlPct.toFixed(1)}% (límite -${pos.stopLossPct}%)\n` +
          `Precio: $${ind.price.toFixed(2)} · entrada promedio: $${pos.avgBuyPrice.toFixed(2)}`,
      ),
    );

    await handleAlert(pairState, "takeProfitAlerted", sellResult.takeProfit.passed, async () =>
      sendTelegram(
        `🟡 <b>${label}: objetivo de ganancia alcanzado</b>\n` +
          `PnL neto: +${sellResult.pnlPct.toFixed(1)}% (objetivo +${pos.takeProfitPct}%)\n` +
          `Precio: $${ind.price.toFixed(2)} · entrada promedio: $${pos.avgBuyPrice.toFixed(2)}`,
      ),
    );

    const technicalSell = sellResult.overbought.passed && sellResult.nearResistance.passed;
    await handleAlert(pairState, "technicalSellAlerted", technicalSell, async () =>
      sendTelegram(
        `🟠 <b>${label}: señal técnica de venta</b>\n` +
          `RSI sobrecomprado y precio cerca de la resistencia de 20 días.\n` +
          `${sellResult.overbought.detail} · ${sellResult.nearResistance.detail}`,
      ),
    );

    await handleAlert(pairState, "trendBreakAlerted", sellResult.trendBreak.passed, async () =>
      sendTelegram(`🟠 <b>${label}: ruptura de tendencia</b>\n${sellResult.trendBreak.detail}`),
    );
  }
}

// Notifies once when a condition turns true, stays quiet while it remains true,
// and re-arms once it clears — so a real trigger always gets a fresh alert.
async function handleAlert(pairState, flagKey, isActive, notify) {
  if (isActive && !pairState[flagKey]) {
    await notify();
    pairState[flagKey] = true;
  } else if (!isActive) {
    pairState[flagKey] = false;
  }
}

async function main() {
  const positions = await readJson(POSITIONS_PATH);
  const state = await readJson(STATE_PATH);
  let hadError = false;

  for (const pair of Object.keys(PAIR_LABELS)) {
    try {
      await checkPair(pair, positions, state);
    } catch (err) {
      hadError = true;
      console.error(`Error checking ${pair}:`, err);
    }
  }

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

  // Fail the job loudly instead of masking a real error (e.g. Binance unreachable) as success.
  if (hadError) process.exitCode = 1;
}

main();
