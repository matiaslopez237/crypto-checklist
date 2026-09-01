import type { Candle, Pair } from "./types";

const KLINES_URL = "https://api.binance.com/api/v3/klines";

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
