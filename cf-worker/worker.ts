// Cloudflare Worker: replaces the unreliable GitHub Actions schedule with
// - fetch(): a Telegram webhook, so /comprar /vender /posicion /reset apply instantly
// - scheduled(): a real cron trigger for the BTC/ETH market check + alerts
import { fetchDailyKlines } from "../src/lib/binance";
import { computeIndicators } from "../src/lib/indicators";
import { buildBuyChecklist, buildSellChecklist } from "../src/lib/checklist";
import { getGitHubFile, putGitHubFile, type GitHubRepoConfig } from "../src/lib/githubContents";
import { handleTelegramCommand, PAIR_LABELS, type PositionsFile } from "../src/lib/telegramCommands";
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
  stopLossAlerted: boolean;
  takeProfitAlerted: boolean;
  technicalSellAlerted: boolean;
  trendBreakAlerted: boolean;
}

const EMPTY_STATE: PairAlertState = {
  lastVerdict: null,
  stopLossAlerted: false,
  takeProfitAlerted: false,
  technicalSellAlerted: false,
  trendBreakAlerted: false,
};

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
  flagKey: keyof Omit<PairAlertState, "lastVerdict">,
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

async function checkPair(env: Env, pair: Pair, positions: PositionsFile): Promise<void> {
  const label = PAIR_LABELS[pair];
  const candles = await fetchDailyKlines(pair, 210);
  const ind = computeIndicators(candles);
  const buyResult = buildBuyChecklist(ind);

  const stored = await env.MONITOR_STATE.get(pair);
  const state: PairAlertState = stored ? JSON.parse(stored) : { ...EMPTY_STATE };

  if (buyResult.verdict === "buy" && state.lastVerdict !== "buy") {
    const passed = buyResult.items.filter((i) => i.passed).map((i) => `• ${i.label}`);
    await sendTelegram(
      env,
      `🟢 <b>${label} entró en zona de compra</b>\n` +
        `Score: ${buyResult.score}/${buyResult.maxScore}\n` +
        `Precio: $${ind.price.toFixed(2)}\n\n` +
        `Cumple:\n${passed.join("\n")}`,
    );
  }
  state.lastVerdict = buyResult.verdict;

  const pos = positions[pair];
  if (pos && pos.avgBuyPrice && pos.qty > 0) {
    const avgBuyPrice = pos.avgBuyPrice;
    const sellResult = buildSellChecklist(ind, avgBuyPrice, pos.stopLossPct, pos.feePct, pos.takeProfitPct);
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
}

async function runMarketCheck(env: Env): Promise<void> {
  let positions: PositionsFile;
  try {
    positions = (await readPositions(env)).positions;
  } catch (err) {
    console.error("Error reading positions.json, skipping this run:", err);
    return;
  }

  for (const pair of Object.keys(PAIR_LABELS) as Pair[]) {
    try {
      await checkPair(env, pair, positions);
    } catch (err) {
      console.error(`Error checking ${pair}:`, err);
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

  const { positions, sha } = await readPositions(env);
  const result = handleTelegramCommand(msg.text, positions);

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
