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

export async function fetchDailyKlines(pair: Pair, limit = 210): Promise<Candle[]> {
  const krakenPair = KRAKEN_PAIRS[pair];
  const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=1440`;
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

  const candles: Candle[] = rows.map(([time, open, high, low, close, , volume]) => ({
    openTime: time * 1000,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    closeTime: time * 1000 + 86399999,
  }));

  return candles.slice(-limit);
}
