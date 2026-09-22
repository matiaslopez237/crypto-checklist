// Cloudflare Worker #2: paper-trading simulation of futures long/short trading
// (no real money — see MEMORY project_crypto_checklist_futures_sim for the approved
// plan). Cron-only; the /futuros and /parar Telegram commands live in the main
// crypto-checklist-monitor Worker, which reads/writes the same GitHub file this one does.
import { getClosedDailyCandles } from "../src/lib/candleCache";
import { getHourlyCandles } from "../src/lib/hourlyCandleCache";
import { computeIndicators } from "../src/lib/indicators";
import { getGitHubFile, putGitHubFile, type GitHubRepoConfig } from "../src/lib/githubContents";
import {
  emptyFuturesSimFile,
  emptyVariantState,
  PAIR_PARAMS,
  VARIANT_PARAMS,
  type FuturesPair,
  type FuturesSimFile,
  type VariantKey,
} from "../src/lib/futuresTypes";
import {
  accrueFunding,
  canOpenPosition,
  closeSlice,
  computeEquity,
  evaluatePosition,
  newTrade,
  resetDayIfNeeded,
  scoreEntry,
  sizePosition,
  trendSide,
} from "../src/lib/futuresEngine";

export interface Env {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  MONITOR_STATE: KVNamespace;
}

const SIM_PATH = "monitor/futures-simulation.json";
const FUTURES_PAIRS: FuturesPair[] = ["ETHUSDT", "SOLUSDT"];
const VARIANT_KEYS: VariantKey[] = ["A-2x", "B-2x", "B-3x"];

function githubConfig(env: Env): GitHubRepoConfig {
  return { token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO };
}

async function readSim(env: Env): Promise<{ file: FuturesSimFile; sha?: string }> {
  const file = await getGitHubFile(githubConfig(env), SIM_PATH);
  if (!file) return { file: emptyFuturesSimFile() };
  const parsed = JSON.parse(file.content) as FuturesSimFile;
  for (const key of VARIANT_KEYS) if (!parsed[key]) parsed[key] = emptyVariantState();
  return { file: parsed, sha: file.sha };
}

async function writeSim(env: Env, file: FuturesSimFile, sha: string | undefined): Promise<void> {
  await putGitHubFile(
    githubConfig(env),
    SIM_PATH,
    JSON.stringify(file, null, 2) + "\n",
    sha,
    "chore: actualizar simulacion de futuros",
  );
}

async function runFuturesCheck(env: Env): Promise<void> {
  const { file, sha } = await readSim(env);
  let dirty = false;
  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);

  // Pass 1: gather each pair's daily trend + hourly entry-timing indicators up front,
  // so every variant's equity/circuit-breaker check this run sees every pair's price,
  // not just the ones already looped over.
  const perPair: Partial<Record<FuturesPair, { trend: ReturnType<typeof trendSide>; price: number; ind: ReturnType<typeof computeIndicators> }>> = {};
  const prices: Partial<Record<FuturesPair, number>> = {};

  for (const pair of FUTURES_PAIRS) {
    try {
      const daily = await getClosedDailyCandles(env.MONITOR_STATE, pair, 210);
      const dailyInd = computeIndicators(daily);
      const hourly = await getHourlyCandles(env.MONITOR_STATE, pair, 210);
      const hourlyInd = computeIndicators(hourly);
      perPair[pair] = { trend: trendSide(dailyInd), price: hourlyInd.price, ind: hourlyInd };
      prices[pair] = hourlyInd.price;
    } catch (err) {
      console.error(`Error checking ${pair}:`, err);
    }
  }

  // Pass 2: manage/open positions per variant, now that every pair's price is known.
  for (const variantKey of VARIANT_KEYS) {
    const variant = file[variantKey];
    const variantParams = VARIANT_PARAMS[variantKey];
    const equityNow = computeEquity(variant, prices);
    resetDayIfNeeded(variant, todayStr, equityNow);

    for (const pair of FUTURES_PAIRS) {
      const data = perPair[pair];
      if (!data) continue;
      const pairParams = PAIR_PARAMS[pair];
      const pos = variant.positions[pair];

      if (pos) {
        const funding = accrueFunding(pos, now);
        if (funding !== 0) {
          variant.cash -= funding;
          dirty = true;
        }

        const action = evaluatePosition(pos, data.price, pairParams.stopPct, pairParams.targetPct, variantParams.exitStyle);
        if (action.type === "closeAll") {
          const { pnlUsd, marginReturned } = closeSlice(pos, data.price, pos.qtyRemaining);
          variant.cash += marginReturned + pnlUsd;
          variant.trades.push(newTrade(pair, pos, data.price, pos.qtyRemaining, pnlUsd, action.reason));
          delete variant.positions[pair];
          dirty = true;
        } else if (action.type === "closePartial") {
          const qtyToClose = pos.qtyRemaining * (action.pct / 100);
          const { pnlUsd, marginReturned } = closeSlice(pos, data.price, qtyToClose);
          variant.cash += marginReturned + pnlUsd;
          variant.trades.push(newTrade(pair, pos, data.price, qtyToClose, pnlUsd, action.reason));
          pos.qtyRemaining -= qtyToClose;
          pos.marginRemaining -= marginReturned;
          pos.partialTaken = true;
          pos.bestPrice = data.price;
          dirty = true;
        } else if (action.type === "updateTrail") {
          pos.bestPrice = action.bestPrice;
          dirty = true;
        }
        continue;
      }

      if (!data.trend) continue;
      const entry = scoreEntry(data.ind, data.trend);
      if (!entry.passed) continue;

      const gate = canOpenPosition(variant, equityNow);
      if (!gate.ok) {
        variant.blockedCount++;
        dirty = true;
        continue;
      }

      const sized = sizePosition(equityNow, pairParams.stopPct, variantParams.leverage, data.price, pairParams.minNotionalUsd);
      if (!sized) {
        variant.blockedCount++;
        dirty = true;
        continue;
      }

      variant.cash -= sized.margin;
      variant.positions[pair] = {
        side: data.trend,
        entryPrice: data.price,
        qty: sized.qty,
        qtyRemaining: sized.qty,
        margin: sized.margin,
        marginRemaining: sized.margin,
        leverage: variantParams.leverage,
        openedAt: new Date(now).toISOString(),
        partialTaken: false,
        bestPrice: data.price,
        lastFundingAt: new Date(now).toISOString(),
      };
      dirty = true;
    }
  }

  if (dirty) await writeSim(env, file, sha);
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runFuturesCheck(env));
  },
};
