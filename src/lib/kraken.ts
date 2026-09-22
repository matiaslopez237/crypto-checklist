import type { Candle, Pair } from "./types";

// Kraken as a fallback data source for server-side (Cloudflare Worker) use: Binance's
// Cloudflare-fronted API blocks requests originating from other Cloudflare Workers
// (confirmed on both api.binance.com and data-api.binance.vision — same 403, both
// served by "server: cloudflare"). The browser app keeps using Binance (src/lib/binance.ts)
// since that works fine from a real browser; this is only wired into the Worker.
const KRAKEN_PAIRS: Record<Pair, string> = { BTCUSDT: "XBTUSD", ETHUSDT: "ETHUSD" };

type KrakenOhlcRow = [number, string, string, string, string, string, string, number];

interface KrakenOhlcResponse {
  error: string[];
  result: Record<string, KrakenOhlcRow[] | number>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `sinceSec` (unix seconds) makes Kraken return only candles after that time instead of
// the full ~720-candle history — parsing that big payload was most of the CPU per run.
//
// Kraken's public API frequently answers "EGeneral:Too many requests" even for these
// light calls (confirmed live: happening on most 5-minute runs) — likely because
// Cloudflare Workers share egress IPs across many customers, so the rate limit isn't
// only ours to control. A couple of short retries clears most of these without costing
// real CPU time (the wait is I/O, not compute).
async function fetchCandles(pair: Pair, sinceSec?: number): Promise<Candle[]> {
  const krakenPair = KRAKEN_PAIRS[pair];
  const since = sinceSec !== undefined ? `&since=${Math.floor(sinceSec)}` : "";
  const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=1440${since}`;

  const retryDelaysMs = [500, 1500];
  let lastErr: Error = new Error("unreachable");
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      return await fetchCandlesOnce(url);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const rateLimited = /too many requests/i.test(lastErr.message);
      if (!rateLimited || attempt === retryDelaysMs.length) throw lastErr;
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

async function fetchCandlesOnce(url: string): Promise<Candle[]> {
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

  return rows.map(([time, open, high, low, close, , volume]) => ({
    openTime: time * 1000,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    closeTime: time * 1000 + 86399999,
  }));
}

export async function fetchDailyKlines(pair: Pair, limit = 210): Promise<Candle[]> {
  return (await fetchCandles(pair)).slice(-limit);
}

export function fetchDailyKlinesSince(pair: Pair, sinceMs: number): Promise<Candle[]> {
  return fetchCandles(pair, sinceMs / 1000);
}
