import type { Candle } from "./types";
import type { FuturesPair } from "./futuresTypes";
import { FUTURES_KRAKEN_PAIRS } from "./futuresTypes";
import { fetchKrakenOhlc } from "./krakenClient";
import type { CandleSource, KvLike } from "./candleCache";

// Same caching trick as candleCache.ts (closed candles cached, only the forming one
// fetched live each run) but for 1-hour candles, used for the futures simulation's
// entry timing. Separate cache key prefix so it never collides with the daily cache.

const HOUR_MS = 3_600_000;
const INTERVAL_MIN = 60;
const cacheKey = (pair: FuturesPair) => `HOURLY:${pair}`;

const krakenHourlySource: CandleSource = {
  full: (pair) => fetchKrakenOhlc(FUTURES_KRAKEN_PAIRS[pair as FuturesPair], INTERVAL_MIN).then((c) => c.slice(-500)),
  since: (pair, sinceMs) => fetchKrakenOhlc(FUTURES_KRAKEN_PAIRS[pair as FuturesPair], INTERVAL_MIN, sinceMs / 1000),
};

type Row = [number, number, number, number, number, number];

const toRow = (c: Candle): Row => [c.openTime, c.open, c.high, c.low, c.close, c.volume];
const fromRow = ([t, open, high, low, close, volume]: Row): Candle => ({
  openTime: t,
  open,
  high,
  low,
  close,
  volume,
  closeTime: t + HOUR_MS - 1,
});

function isContinuous(rows: Row[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] - rows[i - 1][0] !== HOUR_MS) return false;
  }
  return true;
}

export async function getHourlyCandles(
  kv: KvLike,
  pair: FuturesPair,
  limit = 210,
  nowMs: number = Date.now(),
  source: CandleSource = krakenHourlySource,
): Promise<Candle[]> {
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const raw = await kv.get(cacheKey(pair));

  let closed: Row[] | null = null;
  if (raw) {
    try {
      closed = JSON.parse(raw) as Row[];
    } catch {
      closed = null;
    }
  }

  const usable =
    closed !== null &&
    closed.length >= limit - 1 &&
    closed[closed.length - 1][0] === currentHour - HOUR_MS &&
    isContinuous(closed);

  if (usable && closed) {
    const fresh = await source.since(pair, currentHour - 2 * HOUR_MS);
    const forming = fresh.filter((c) => c.openTime >= currentHour).at(-1);
    if (forming) return [...closed.slice(-(limit - 1)).map(fromRow), forming];
    return (await source.full(pair)).slice(-limit);
  }

  const all = await source.full(pair);
  const closedRows = all.filter((c) => c.openTime < currentHour).slice(-(limit - 1)).map(toRow);
  const json = JSON.stringify(closedRows);
  if (json !== raw) await kv.put(cacheKey(pair), json);
  return all.slice(-limit);
}

// Just the current price — for the /futuros command's summary (doesn't need the
// full candle history, and avoids pulling in the daily-cache's spot-only Pair type).
export async function fetchLatestFuturesPrice(
  pair: FuturesPair,
  nowMs: number = Date.now(),
  source: CandleSource = krakenHourlySource,
): Promise<number> {
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const last = (await source.since(pair, currentHour - 2 * HOUR_MS)).at(-1);
  if (!last) throw new Error("Kraken API: no recent candles");
  return last.close;
}
