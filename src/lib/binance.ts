import type { Candle, Pair } from "./types";

// data-api.binance.vision is Binance's public market-data mirror: same response shape
// as api.binance.com, but meant for exactly this kind of read-only, unauthenticated
// access and not subject to the same regional trading restrictions (api.binance.com
// returns 451 from US-hosted infra, which is where GitHub Actions runners live).
const KLINES_URL = "https://data-api.binance.vision/api/v3/klines";

// Binance kline array shape: [openTime, open, high, low, close, volume, closeTime, ...]
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

export async function fetchDailyKlines(pair: Pair, limit = 210): Promise<Candle[]> {
  const url = `${KLINES_URL}?symbol=${pair}&interval=1d&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance API error (${res.status}): ${res.statusText}`);
  }
  const raw = (await res.json()) as RawKline[];
  return raw.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
  }));
}
