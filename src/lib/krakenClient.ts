import type { Candle } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type KrakenOhlcRow = [number, string, string, string, string, string, string, number];

interface KrakenOhlcResponse {
  error: string[];
  result: Record<string, KrakenOhlcRow[] | number>;
}

// Shared by the daily (spot) and hourly (futures) candle fetchers. Kraken's public API
// frequently answers "EGeneral:Too many requests" (confirmed live, likely because
// Cloudflare Workers share egress IPs with many other customers) — a couple of short
// retries clears most of these without costing real CPU (the wait is I/O, not compute).
export async function fetchKrakenOhlc(krakenPair: string, intervalMinutes: number, sinceSec?: number): Promise<Candle[]> {
  const since = sinceSec !== undefined ? `&since=${Math.floor(sinceSec)}` : "";
  const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${intervalMinutes}${since}`;

  const retryDelaysMs = [500, 1500];
  let lastErr: Error = new Error("unreachable");
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      return await fetchOnce(url, intervalMinutes);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const rateLimited = /too many requests/i.test(lastErr.message);
      if (!rateLimited || attempt === retryDelaysMs.length) throw lastErr;
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

async function fetchOnce(url: string, intervalMinutes: number): Promise<Candle[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Kraken API error (${res.status}): ${res.statusText}`);
  }

  const data = (await res.json()) as KrakenOhlcResponse;
  if (data.error?.length) {
    throw new Error(`Kraken API error: ${data.error.join(", ")}`);
  }

  // Kraken keys the result by its own internal pair name (e.g. XXBTZUSD, not the
  // "XBTUSD" we requested), plus a "last" cursor field — grab the actual data key.
  const key = Object.keys(data.result).find((k) => k !== "last");
  const rows = key ? (data.result[key] as KrakenOhlcRow[]) : null;
  if (!rows) throw new Error("Kraken API: no OHLC data in response");

  const intervalMs = intervalMinutes * 60_000;
  return rows.map(([time, open, high, low, close, , volume]) => ({
    openTime: time * 1000,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    closeTime: time * 1000 + intervalMs - 1,
  }));
}
