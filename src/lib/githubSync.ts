import type { GitHubSyncConfig } from "./storage";
import type { Pair } from "./types";

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

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function syncPositionsToGitHub(
  config: GitHubSyncConfig,
  positions: Partial<Record<Pair, { avgBuyPrice: number | null; qty: number }>>,
): Promise<{ updated: boolean }> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${POSITIONS_PATH}`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getRes = await fetch(url, { headers });
  let sha: string | undefined;
  let current: PositionsFile = {};

  if (getRes.status === 200) {
    const data = await getRes.json();
    sha = data.sha;
    current = JSON.parse(fromBase64(data.content));
  } else if (getRes.status === 401 || getRes.status === 403) {
    throw new Error("Token inválido o sin permiso de escritura sobre el repo.");
  } else if (getRes.status !== 404) {
    throw new Error(`Error de GitHub (${getRes.status}) al leer ${POSITIONS_PATH}.`);
  }

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

  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "chore: sync posición desde la app",
      content: toBase64(JSON.stringify(next, null, 2) + "\n"),
      sha,
    }),
  });

  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new Error(`Error de GitHub (${putRes.status}) al actualizar ${POSITIONS_PATH}. ${body}`);
  }

  return { updated: true };
}
