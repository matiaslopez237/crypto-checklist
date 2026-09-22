// Cloudflare Worker: replaces the unreliable GitHub Actions schedule with
// - fetch(): a Telegram webhook, so /comprar /vender /posicion /reset apply instantly
// - scheduled(): a real cron trigger for the BTC/ETH market check + alerts
import { getDailyCandles, fetchLatestCandle } from "../src/lib/candleCache";
import { computeIndicators } from "../src/lib/indicators";
import { buildBuyChecklist, buildSellChecklist } from "../src/lib/checklist";
import { getGitHubFile, putGitHubFile, type GitHubRepoConfig } from "../src/lib/githubContents";
import { handleTelegramCommand, normalizePair, fmt, PAIR_LABELS, type PositionsFile } from "../src/lib/telegramCommands";
import {
  applyPaperBuy,
  applyPaperSell,
  buildPaperSummary,
  emptyPaperPortfolio,
  emptyPaperPosition,
  PAPER_THRESHOLDS,
  type PaperPortfolio,
} from "../src/lib/paperTrading";
import type { Indicators, Pair } from "../src/lib/types";
import { fetchLatestFuturesPrice } from "../src/lib/hourlyCandleCache";
import { buildFuturesSummary } from "../src/lib/futuresSummary";
import { emptyFuturesSimFile, emptyVariantState, type FuturesPair, type FuturesSimFile, type VariantKey } from "../src/lib/futuresTypes";
import { evaluateBuyZone, markIfActive, rearmConditions } from "../src/lib/spotStrategy";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  MONITOR_STATE: KVNamespace;
}

const POSITIONS_PATH = "monitor/positions.json";
const PAPER_TRADING_PATH = "monitor/paper-trading.json";
const FUTURES_SIM_PATH = "monitor/futures-simulation.json";
const FUTURES_PAIRS: FuturesPair[] = ["ETHUSDT", "SOLUSDT"];
const VARIANT_KEYS: VariantKey[] = ["A-2x", "B-2x"];

interface PairAlertState {
  lastVerdict: string | null;
  lastNotifiedBuyScore: number | null;
  stopLossAlerted: boolean;
  takeProfitAlerted: boolean;
  technicalSellAlerted: boolean;
  trendBreakAlerted: boolean;
}

const EMPTY_STATE: PairAlertState = {
  lastVerdict: null,
  lastNotifiedBuyScore: null,
  stopLossAlerted: false,
  takeProfitAlerted: false,
  technicalSellAlerted: false,
  trendBreakAlerted: false,
};

interface PriceAlert {
  id: string;
  pair: Pair;
  targetPrice: number;
  side: "above" | "below"; // which side of targetPrice the price was on when created
}

const PRICE_ALERTS_KEY = "PRICE_ALERTS";
const DIGEST_KEY = "DIGEST";
const DIGEST_HOUR_UTC = 12; // ~09:00 in Argentina (UTC-3)

function sideOf(price: number, target: number): "above" | "below" {
  return price >= target ? "above" : "below";
}

async function loadPriceAlerts(env: Env): Promise<PriceAlert[]> {
  const stored = await env.MONITOR_STATE.get(PRICE_ALERTS_KEY);
  return stored ? JSON.parse(stored) : [];
}

async function savePriceAlerts(env: Env, alerts: PriceAlert[]): Promise<void> {
  await env.MONITOR_STATE.put(PRICE_ALERTS_KEY, JSON.stringify(alerts));
}

interface PairSummary {
  label: string;
  price: number;
  score: number;
  maxScore: number;
  verdict: string;
  pnlPct: number | null;
}

function githubConfig(env: Env): GitHubRepoConfig {
  return { token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO };
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    console.error("Telegram sendMessage failed", res.status, await res.text());
  }
}

async function readPositions(env: Env): Promise<{ positions: PositionsFile; sha?: string }> {
  const file = await getGitHubFile(githubConfig(env), POSITIONS_PATH);
  return file ? { positions: JSON.parse(file.content), sha: file.sha } : { positions: {} };
}

async function readPaperPortfolio(env: Env): Promise<{ portfolio: PaperPortfolio; sha?: string }> {
  const file = await getGitHubFile(githubConfig(env), PAPER_TRADING_PATH);
  return file ? { portfolio: JSON.parse(file.content), sha: file.sha } : { portfolio: emptyPaperPortfolio() };
}

async function writePaperPortfolio(env: Env, portfolio: PaperPortfolio, sha: string | undefined): Promise<void> {
  await putGitHubFile(
    githubConfig(env),
    PAPER_TRADING_PATH,
    JSON.stringify(portfolio, null, 2) + "\n",
    sha,
    "chore: actualizar simulacion de papel",
  );
}

// Written by the separate crypto-checklist-futures-sim Worker; this Worker only reads
// it (for /futuros) and flips `paused` (for /parar, /reanudar) — the actual trading
// logic lives over there.
async function readFuturesSim(env: Env): Promise<{ file: FuturesSimFile; sha?: string }> {
  const file = await getGitHubFile(githubConfig(env), FUTURES_SIM_PATH);
  if (!file) return { file: emptyFuturesSimFile() };
  const parsed = JSON.parse(file.content) as FuturesSimFile;
  for (const key of VARIANT_KEYS) if (!parsed[key]) parsed[key] = emptyVariantState();
  return { file: parsed, sha: file.sha };
}

async function writeFuturesSim(env: Env, file: FuturesSimFile, sha: string | undefined): Promise<void> {
  await putGitHubFile(
    githubConfig(env),
    FUTURES_SIM_PATH,
    JSON.stringify(file, null, 2) + "\n",
    sha,
    "chore: pausar/reanudar simulacion de futuros",
  );
}

// Notifies once when a condition turns true, stays quiet while it remains true,
// and re-arms once it clears — so a real trigger always gets a fresh alert.
async function handleAlert(
  state: PairAlertState,
  flagKey: keyof Omit<PairAlertState, "lastVerdict" | "lastNotifiedBuyScore">,
  isActive: boolean,
  notify: () => Promise<void>,
  clearWhen: boolean = !isActive, // must imply !isActive; wider than it = hysteresis band
): Promise<void> {
  if (isActive && !state[flagKey]) {
    await notify();
    state[flagKey] = true;
  } else if (clearWhen) {
    state[flagKey] = false;
  }
}

async function checkPair(
  env: Env,
  pair: Pair,
  positions: PositionsFile,
  priceAlerts: PriceAlert[],
  paperPortfolio: PaperPortfolio,
): Promise<{ summary: PairSummary; firedAlertIds: string[] }> {
  const label = PAIR_LABELS[pair];
  const candles = await getDailyCandles(env.MONITOR_STATE, pair, 210);
  const ind = computeIndicators(candles);
  const buyResult = buildBuyChecklist(ind);

  const firedAlertIds: string[] = [];
  for (const alert of priceAlerts) {
    if (alert.pair !== pair) continue;
    const currentSide = sideOf(ind.price, alert.targetPrice);
    if (currentSide !== alert.side) {
      await sendTelegram(
        env,
        `🔔 <b>${label} cruzó $${fmt(alert.targetPrice)}</b>\nPrecio actual: $${ind.price.toFixed(2)}`,
      );
      firedAlertIds.push(alert.id);
    }
  }

  const stored = await env.MONITOR_STATE.get(pair);
  const state: PairAlertState = { ...EMPTY_STATE, ...(stored ? JSON.parse(stored) : {}) };
  const stateBefore = JSON.stringify(state);

  const previousBuyScore = state.lastNotifiedBuyScore; // for the "mejoró" message, before evaluateBuyZone overwrites it
  const { enteredBuyZoneNow, buyZoneImprovedEnough } = evaluateBuyZone(state, buyResult);

  if (enteredBuyZoneNow || buyZoneImprovedEnough) {
    const passed = buyResult.items.filter((i) => i.passed).map((i) => `• ${i.label}`);
    const heading = enteredBuyZoneNow
      ? `🟢 <b>${label} entró en zona de compra</b>`
      : `🟢📈 <b>${label} mejoró la zona de compra</b>\n(antes ${previousBuyScore}/${buyResult.maxScore})`;
    await sendTelegram(
      env,
      `${heading}\n` +
        `Score: ${buyResult.score}/${buyResult.maxScore}\n` +
        `Precio: $${ind.price.toFixed(2)}\n\n` +
        `Cumple:\n${passed.join("\n")}`,
    );
  }

  let pnlPct: number | null = null;
  const pos = positions[pair];
  if (pos && pos.avgBuyPrice && pos.qty > 0) {
    const avgBuyPrice = pos.avgBuyPrice;
    const sellResult = buildSellChecklist(ind, avgBuyPrice, pos.stopLossPct, pos.feePct, pos.takeProfitPct);
    pnlPct = sellResult.pnlPct;
    const suggestion = sellResult.suggestedSellPct > 0 ? `\n\n💡 Sugerencia: vender ${sellResult.suggestedSellPct}%` : "";
    const rearm = rearmConditions(ind, sellResult.pnlPct, pos.stopLossPct, pos.takeProfitPct);

    await handleAlert(
      state,
      "stopLossAlerted",
      sellResult.stopLoss.passed,
      () =>
        sendTelegram(
          env,
          `🔴 <b>${label}: alerta de stop loss</b>\n` +
            `PnL neto: ${sellResult.pnlPct.toFixed(1)}% (límite -${pos.stopLossPct}%)\n` +
            `Precio: $${ind.price.toFixed(2)} · entrada promedio: $${avgBuyPrice.toFixed(2)}${suggestion}`,
        ),
      rearm.stopLoss,
    );

    await handleAlert(
      state,
      "takeProfitAlerted",
      sellResult.takeProfit.passed,
      () =>
        sendTelegram(
          env,
          `🟡 <b>${label}: objetivo de ganancia alcanzado</b>\n` +
            `PnL neto: +${sellResult.pnlPct.toFixed(1)}% (objetivo +${pos.takeProfitPct}%)\n` +
            `Precio: $${ind.price.toFixed(2)} · entrada promedio: $${avgBuyPrice.toFixed(2)}${suggestion}`,
        ),
      rearm.takeProfit,
    );

    const technicalSell = sellResult.overbought.passed && sellResult.nearResistance.passed;
    await handleAlert(
      state,
      "technicalSellAlerted",
      technicalSell,
      () =>
        sendTelegram(
          env,
          `🟠 <b>${label}: señal técnica de venta</b>\n` +
            `RSI sobrecomprado y precio cerca de la resistencia de 20 días.\n` +
            `${sellResult.overbought.detail} · ${sellResult.nearResistance.detail}${suggestion}`,
        ),
      rearm.technical,
    );

    await handleAlert(
      state,
      "trendBreakAlerted",
      sellResult.trendBreak.passed,
      () => sendTelegram(env, `🟠 <b>${label}: ruptura de tendencia</b>\n${sellResult.trendBreak.detail}${suggestion}`),
      rearm.trendBreak,
    );
  }

  // Paper trading: act on the exact same signals as above, but against a separate
  // fake portfolio and never via Telegram — purely for backtesting the strategy.
  if (enteredBuyZoneNow || buyZoneImprovedEnough) {
    applyPaperBuy(paperPortfolio, pair, ind.price, enteredBuyZoneNow ? "entrada en zona de compra" : "mejora de zona de compra");
  }

  const paperPos = paperPortfolio.positions[pair];
  if (paperPos && paperPos.qty > 0 && paperPos.avgBuyPrice) {
    const paperSell = buildSellChecklist(
      ind,
      paperPos.avgBuyPrice,
      PAPER_THRESHOLDS.stopLossPct,
      PAPER_THRESHOLDS.feePct,
      PAPER_THRESHOLDS.takeProfitPct,
    );

    // Stop loss is the hard rule (full exit, matches the real checklist's philosophy).
    // The softer signals share one combined sell using the same suggestedSellPct shown
    // to the user, fired once whenever a new one of them joins (not re-fired while
    // the same set stays active).
    const paperRearm = rearmConditions(ind, paperSell.pnlPct, PAPER_THRESHOLDS.stopLossPct, PAPER_THRESHOLDS.takeProfitPct);
    const stopLossNew = markIfActive(paperPos, "stopLossAlerted", paperSell.stopLoss.passed, paperRearm.stopLoss);
    const takeProfitNew = markIfActive(paperPos, "takeProfitAlerted", paperSell.takeProfit.passed, paperRearm.takeProfit);
    const technicalNew = markIfActive(
      paperPos,
      "technicalSellAlerted",
      paperSell.overbought.passed && paperSell.nearResistance.passed,
      paperRearm.technical,
    );
    const trendBreakNew = markIfActive(paperPos, "trendBreakAlerted", paperSell.trendBreak.passed, paperRearm.trendBreak);

    if (stopLossNew) {
      applyPaperSell(paperPortfolio, pair, ind.price, 100, "stop loss");
    } else if ((takeProfitNew || technicalNew || trendBreakNew) && paperSell.suggestedSellPct > 0) {
      const reasons = [takeProfitNew && "take profit", technicalNew && "señal técnica", trendBreakNew && "ruptura de tendencia"]
        .filter(Boolean)
        .join(" + ");
      applyPaperSell(paperPortfolio, pair, ind.price, paperSell.suggestedSellPct, reasons);
    }
  } else if (paperPortfolio.positions[pair]) {
    // Position fully closed out — reset dedup flags so a future re-entry starts clean.
    paperPortfolio.positions[pair] = emptyPaperPosition();
  }

  // Skip the write entirely when nothing actually changed — at a 5-minute cron,
  // writing every run regardless would burn through the KV free tier's daily
  // write cap in a matter of hours (confirmed: this was the bug).
  const stateAfter = JSON.stringify(state);
  if (stateAfter !== stateBefore) {
    await env.MONITOR_STATE.put(pair, stateAfter);
  }

  return {
    summary: { label, price: ind.price, score: buyResult.score, maxScore: buyResult.maxScore, verdict: buyResult.verdict, pnlPct },
    firedAlertIds,
  };
}

function buildDigestText(summaries: PairSummary[]): string {
  const lines = summaries.map((s) => {
    const verdictLabel = s.verdict === "buy" ? "zona de compra" : s.verdict === "watch" ? "zona dudosa" : "no conviene";
    const pnlText = s.pnlPct !== null ? ` · PnL neto: ${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(1)}%` : "";
    return `${s.label}: $${fmt(s.price)} · Score ${s.score}/${s.maxScore} (${verdictLabel})${pnlText}`;
  });
  return `📋 <b>Resumen diario</b>\n${lines.join("\n")}`;
}

async function runMarketCheck(env: Env): Promise<void> {
  let positions: PositionsFile;
  try {
    positions = (await readPositions(env)).positions;
  } catch (err) {
    console.error("Error reading positions.json, skipping this run:", err);
    return;
  }

  const pendingAlerts = await loadPriceAlerts(env);
  const { portfolio: paperPortfolio, sha: paperSha } = await readPaperPortfolio(env);
  const tradesBefore = paperPortfolio.trades.length;
  const firedIds: string[] = [];
  const summaries: PairSummary[] = [];

  for (const pair of Object.keys(PAIR_LABELS) as Pair[]) {
    try {
      const { summary, firedAlertIds } = await checkPair(env, pair, positions, pendingAlerts, paperPortfolio);
      summaries.push(summary);
      firedIds.push(...firedAlertIds);
    } catch (err) {
      console.error(`Error checking ${pair}:`, err);
    }
  }

  if (paperPortfolio.trades.length > tradesBefore) {
    await writePaperPortfolio(env, paperPortfolio, paperSha);
  }

  if (firedIds.length > 0) {
    await savePriceAlerts(env, pendingAlerts.filter((a) => !firedIds.includes(a.id)));
  }

  const now = new Date();
  const allPairsOk = summaries.length === Object.keys(PAIR_LABELS).length;
  // Kraken sometimes rejects a pair with "Too many requests" (checkPair's catch above
  // logs it and drops that pair from `summaries` for this run). Only send+mark the
  // digest once every pair came through clean, so a single unlucky rate-limit hit
  // during the digest hour just gets retried by the next 5-minute run instead of
  // permanently shipping an incomplete summary for the day.
  if (now.getUTCHours() === DIGEST_HOUR_UTC && allPairsOk) {
    const todayStr = now.toISOString().slice(0, 10);
    const digestStored = await env.MONITOR_STATE.get(DIGEST_KEY);
    const lastDigestDate = digestStored ? JSON.parse(digestStored).lastDate : null;
    if (lastDigestDate !== todayStr) {
      await sendTelegram(env, buildDigestText(summaries));
      await env.MONITOR_STATE.put(DIGEST_KEY, JSON.stringify({ lastDate: todayStr }));
    }
  }
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const update = (await request.json().catch(() => null)) as { message?: { text?: string; chat?: { id?: number | string } } } | null;
  const msg = update?.message;

  // Ignore anyone but the configured owner — these commands write to the repo.
  if (!msg?.text || String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return new Response("ok");
  }

  const text = msg.text.trim();

  if (/^\/?papel(@|$|\s)/i.test(text)) {
    const { portfolio } = await readPaperPortfolio(env);
    const prices: Partial<Record<Pair, number>> = {};
    for (const pair of Object.keys(PAIR_LABELS) as Pair[]) {
      try {
        const latest = await fetchLatestCandle(pair);
        prices[pair] = latest.close;
      } catch (err) {
        console.error(`Error fetching price for ${pair}:`, err);
      }
    }
    await sendTelegram(env, buildPaperSummary(portfolio, prices));
    return new Response("ok");
  }

  if (/^\/?futuros(@|$|\s)/i.test(text)) {
    const { file } = await readFuturesSim(env);
    const prices: Partial<Record<FuturesPair, number>> = {};
    for (const pair of FUTURES_PAIRS) {
      try {
        prices[pair] = await fetchLatestFuturesPrice(pair);
      } catch (err) {
        console.error(`Error fetching futures price for ${pair}:`, err);
      }
    }
    await sendTelegram(env, buildFuturesSummary(file, prices));
    return new Response("ok");
  }

  if (/^\/?(parar|pausar)(@|$|\s)/i.test(text)) {
    const { file, sha } = await readFuturesSim(env);
    for (const key of VARIANT_KEYS) file[key].paused = true;
    await writeFuturesSim(env, file, sha);
    await sendTelegram(env, "⏸ Simulación de futuros pausada: no se abrirán posiciones nuevas (las abiertas se siguen gestionando). Usá /reanudar para volver a activarla.");
    return new Response("ok");
  }

  if (/^\/?reanudar(@|$|\s)/i.test(text)) {
    const { file, sha } = await readFuturesSim(env);
    for (const key of VARIANT_KEYS) file[key].paused = false;
    await writeFuturesSim(env, file, sha);
    await sendTelegram(env, "▶️ Simulación de futuros reanudada.");
    return new Response("ok");
  }

  // Price alerts live in KV, not in positions.json, so they're handled here rather
  // than in telegramCommands.ts (which only knows about position state).
  if (/^\/?alertas(@|$|\s)/i.test(text)) {
    const alerts = await loadPriceAlerts(env);
    const reply =
      alerts.length === 0
        ? "No tenés alertas de precio pendientes."
        : alerts.map((a) => `${PAIR_LABELS[a.pair]}: $${fmt(a.targetPrice)}`).join("\n");
    await sendTelegram(env, reply);
    return new Response("ok");
  }

  if (/^\/?alerta(@\S+)?(\s|$)/i.test(text)) {
    const parts = text.split(/\s+/);
    const pair = normalizePair(parts[1]);
    const targetPrice = Number(parts[2]);
    if (!pair || !targetPrice) {
      await sendTelegram(env, "No entendí. Uso: /alerta BTC 68000");
      return new Response("ok");
    }

    try {
      const latest = await fetchLatestCandle(pair);
      const currentPrice = latest.close;
      const alerts = await loadPriceAlerts(env);
      alerts.push({
        id: crypto.randomUUID(),
        pair,
        targetPrice,
        side: sideOf(currentPrice, targetPrice),
      });
      await savePriceAlerts(env, alerts);
      await sendTelegram(
        env,
        `🔔 Alerta creada: ${PAIR_LABELS[pair]} @ $${fmt(targetPrice)} (precio actual: $${currentPrice.toFixed(2)})`,
      );
    } catch (err) {
      console.error("Error creating price alert:", err);
      await sendTelegram(env, "No pude crear la alerta, intentá de nuevo en un rato.");
    }
    return new Response("ok");
  }

  // /posicion wants a live PnL%, which needs the current price — skip the extra
  // Kraken calls for commands that don't need it (comprar/vender/reset).
  const isPositionQuery = /^\/?(posicion|position|status)(@|$|\s)/i.test(text);
  let prices: Partial<Record<Pair, number>> | undefined;
  if (isPositionQuery) {
    prices = {};
    for (const pair of Object.keys(PAIR_LABELS) as Pair[]) {
      try {
        const latest = await fetchLatestCandle(pair);
        prices[pair] = latest.close;
      } catch (err) {
        console.error(`Error fetching price for ${pair}:`, err);
      }
    }
  }

  const { positions, sha } = await readPositions(env);
  const result = handleTelegramCommand(text, positions, prices);

  if (result.changed) {
    await putGitHubFile(
      githubConfig(env),
      POSITIONS_PATH,
      JSON.stringify(positions, null, 2) + "\n",
      sha,
      "chore: aplicar comando de Telegram",
    );
  }

  await sendTelegram(env, result.reply);
  return new Response("ok");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("ok");
    // Telegram includes this header on every webhook delivery when a secret_token is
    // configured — without it, anyone who finds this URL could forge commands (the
    // chat_id alone isn't secret).
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      return await handleTelegramWebhook(request, env);
    } catch (err) {
      console.error("Webhook error:", err);
      return new Response("ok"); // always 200 so Telegram doesn't retry-storm us
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMarketCheck(env));
  },
};
