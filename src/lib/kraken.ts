import type { Candle } from "./types";
import { fetchKrakenOhlc } from "./krakenClient";
import { krakenPairCode } from "./krakenPairs";

// Kraken as a fallback data source for server-side (Cloudflare Worker) use: Binance's
// Cloudflare-fronted API blocks requests originating from other Cloudflare Workers
// (confirmed on both api.binance.com and data-api.binance.vision — same 403, both
// served by "server: cloudflare"). The browser app keeps using Binance (src/lib/binance.ts)
// since that works fine from a real browser; this is only wired into the Worker.
const DAILY_INTERVAL_MIN = 1440;

export async function fetchDailyKlines(pair: string, limit = 210): Promise<Candle[]> {
  const candles = await fetchKrakenOhlc(krakenPairCode(pair), DAILY_INTERVAL_MIN);
  return candles.slice(-limit);
}

// `sinceMs` makes Kraken return only candles after that time instead of the full
// ~720-candle history — parsing that big payload was most of the CPU per run.
export function fetchDailyKlinesSince(pair: string, sinceMs: number): Promise<Candle[]> {
  return fetchKrakenOhlc(krakenPairCode(pair), DAILY_INTERVAL_MIN, sinceMs / 1000);
}
