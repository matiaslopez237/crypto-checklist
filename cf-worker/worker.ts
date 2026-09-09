// Cloudflare Worker: replaces the unreliable GitHub Actions schedule with
// - fetch(): a Telegram webhook, so /comprar /vender /posicion /reset apply instantly
// - scheduled(): a real cron trigger for the BTC/ETH market check + alerts
import { fetchDailyKlines } from "../src/lib/kraken";
import { computeIndicators } from "../src/lib/indicators";
import { buildBuyChecklist, buildSellChecklist } from "../src/lib/checklist";
import { getGitHubFile, putGitHubFile, type GitHubRepoConfig } from "../src/lib/githubContents";
import { handleTelegramCommand, normalizePair, fmt, PAIR_LABELS, type PositionsFile } from "../src/lib/telegramCommands";
import type { Pair } from "../src/lib/types";

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

// How many extra points the buy score needs to gain (while still in the green
// zone) before re-notifying — e.g. price kept dropping toward support, a better
// entry than the one you were already told about.
const BUY_SCORE_IMPROVEMENT_THRESHOLD = 15;

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

// Notifies once when a condition turns true, stays quiet while it remains true,
// and re-arms once it clears — so a real trigger always gets a fresh alert.
async function handleAlert(
  state: PairAlertState,
  flagKey: keyof Omit<PairAlertState, "lastVerdict" | "lastNotifiedBuyScore">,
  isActive: boolean,
  notify: () => Promise<void>,
): Promise<void> {
  if (isActive && !state[flagKey]) {
    await notify();
    state[flagKey] = true;
  } else if (!isActive) {
    state[flagKey] = false;
  }
}

async function checkPair(
  env: Env,
  pair: Pair,
  positions: PositionsFile,
  priceAlerts: PriceAlert[],
): Promise<{ summary: PairSummary; firedAlertIds: string[] }> {
  const label = PAIR_LABELS[pair];
  const candles = await fetchDailyKlines(pair, 210);
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

  if (buyResult.verdict === "buy") {
    const enteredNow = state.lastVerdict !== "buy";
    const improvedEnough =
      !enteredNow &&
      state.lastNotifiedBuyScore !== null &&
      buyResult.score >= state.lastNotifiedBuyScore + BUY_SCORE_IMPROVEMENT_THRESHOLD;

    if (enteredNow || improvedEnough) {
      const passed = buyResult.items.filter((i) => i.passed).map((i) => `• ${i.label}`);
      const heading = enteredNow
        ? `🟢 <b>${label} entró en zona de compra</b>`
        : `🟢📈 <b>${label} mejoró la zona de compra</b>\n(antes ${state.lastNotifiedBuyScore}/${buyResult.maxScore})`;
      await sendTelegram(
        env,
        `${heading}\n` +
          `Score: ${buyResult.score}/${buyResult.maxScore}\n` +
          `Precio: $${ind.price.toFixed(2)}\n\n` +
          `Cumple:\n${passed.join("\n")}`,
      );
      state.lastNotifiedBuyScore = buyResult.score;
    }
  } else {
    // Reset so the next time it re-enters the green zone starts a fresh comparison.
    state.lastNotifiedBuyScore = null;
  }
  state.lastVerdict = buyResult.verdict;

  let pnlPct: number | null = null;
  const pos = positions[pair];
  if (pos && pos.avgBuyPrice && pos.qty > 0) {
    const avgBuyPrice = pos.avgBuyPrice;
    const sellResult = buildSellChecklist(ind, avgBuyPrice, pos.stopLossPct, pos.feePct, pos.takeProfitPct);
    pnlPct = sellResult.pnlPct;
    const suggestion = sellResult.suggestedSellPct > 0 ? `\n\n💡 Sugerencia: vender ${sellResult.suggestedSellPct}%` : "";

    await handleAlert(state, "stopLossAlerted", sellResult.stopLoss.passed, () =>
      sendTelegram(
        env,
        `🔴 <b>${label}: alerta de stop loss</b>\n` +
          `PnL neto: ${sellResult.pnlPct.toFixed(1)}% (límite -${pos.stopLossPct}%)\n` +
          `Precio: $${ind.price.toFixed(2)} · entrada promedio: $${avgBuyPrice.toFixed(2)}${suggestion}`,
      ),
    );

    await handleAlert(state, "takeProfitAlerted", sellResult.takeProfit.passed, () =>
      sendTelegram(
        env,
        `🟡 <b>${label}: objetivo de ganancia alcanzado</b>\n` +
          `PnL neto: +${sellResult.pnlPct.toFixed(1)}% (objetivo +${pos.takeProfitPct}%)\n` +
          `Precio: $${ind.price.toFixed(2)} · entrada promedio: $${avgBuyPrice.toFixed(2)}${suggestion}`,
      ),
    );

    const technicalSell = sellResult.overbought.passed && sellResult.nearResistance.passed;
    await handleAlert(state, "technicalSellAlerted", technicalSell, () =>
      sendTelegram(
        env,
        `🟠 <b>${label}: señal técnica de venta</b>\n` +
          `RSI sobrecomprado y precio cerca de la resistencia de 20 días.\n` +
          `${sellResult.overbought.detail} · ${sellResult.nearResistance.detail}${suggestion}`,
      ),
    );

    await handleAlert(state, "trendBreakAlerted", sellResult.trendBreak.passed, () =>
      sendTelegram(env, `🟠 <b>${label}: ruptura de tendencia</b>\n${sellResult.trendBreak.detail}${suggestion}`),
    );
  }

  await env.MONITOR_STATE.put(pair, JSON.stringify(state));

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
  const firedIds: string[] = [];
  const summaries: PairSummary[] = [];

  for (const pair of Object.keys(PAIR_LABELS) as Pair[]) {
    try {
      const { summary, firedAlertIds } = await checkPair(env, pair, positions, pendingAlerts);
      summaries.push(summary);
      firedIds.push(...firedAlertIds);
    } catch (err) {
      console.error(`Error checking ${pair}:`, err);
    }
  }

  if (firedIds.length > 0) {
    await savePriceAlerts(env, pendingAlerts.filter((a) => !firedIds.includes(a.id)));
  }

  const now = new Date();
  if (now.getUTCHours() === DIGEST_HOUR_UTC && summaries.length > 0) {
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
      const candles = await fetchDailyKlines(pair, 1);
      const currentPrice = candles[candles.length - 1].close;
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
        const candles = await fetchDailyKlines(pair, 1);
        prices[pair] = candles[candles.length - 1].close;
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
