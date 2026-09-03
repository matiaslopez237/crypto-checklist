import type { GitHubSyncConfig } from "./storage";
import type { Pair } from "./types";
import { getGitHubFile, putGitHubFile } from "./githubContents";

const POSITIONS_PATH = "monitor/positions.json";

interface StoredPosition {
  avgBuyPrice: number | null;
  qty: number;
  stopLossPct: number;
  takeProfitPct: number;
  feePct: number;
}

type PositionsFile = Partial<Record<Pair, StoredPosition>>;

const DEFAULT_THRESHOLDS = { stopLossPct: 10, takeProfitPct: 20, feePct: 0.1 };

export async function syncPositionsToGitHub(
  config: GitHubSyncConfig,
  positions: Partial<Record<Pair, { avgBuyPrice: number | null; qty: number }>>,
): Promise<{ updated: boolean }> {
  const file = await getGitHubFile(config, POSITIONS_PATH);
  const current: PositionsFile = file ? JSON.parse(file.content) : {};

  const next: PositionsFile = { ...current };
  for (const [pair, pos] of Object.entries(positions) as [Pair, { avgBuyPrice: number | null; qty: number }][]) {
    const existing = current[pair];
    next[pair] = {
      stopLossPct: existing?.stopLossPct ?? DEFAULT_THRESHOLDS.stopLossPct,
      takeProfitPct: existing?.takeProfitPct ?? DEFAULT_THRESHOLDS.takeProfitPct,
      feePct: existing?.feePct ?? DEFAULT_THRESHOLDS.feePct,
      avgBuyPrice: pos.avgBuyPrice,
      qty: pos.qty,
    };
  }

  if (JSON.stringify(next) === JSON.stringify(current)) {
    return { updated: false };
  }

  await putGitHubFile(config, POSITIONS_PATH, JSON.stringify(next, null, 2) + "\n", file?.sha, "chore: sync posición desde la app");
  return { updated: true };
}
