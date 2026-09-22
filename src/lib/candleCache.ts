import type { Candle, Pair } from "./types";
import { fetchDailyKlines, fetchDailyKlinesSince } from "./kraken";

// Closed daily candles never change, so they're cached and each 5-minute run only
// downloads the still-forming candle. The result is the exact same candle list the
// old "download ~720 candles every run" code produced (same 210-candle window, same
// forming candle last), just without parsing that whole payload each time.
// Full re-download happens on cache miss and once per day when a candle closes.

const DAY_MS = 86_400_000;
const cacheKey = (pair: Pair) => `CANDLES:${pair}`;

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface CandleSource {
  full(pair: Pair): Promise<Candle[]>;
  since(pair: Pair, sinceMs: number): Promise<Candle[]>;
}

const krakenSource: CandleSource = {
  full: (pair) => fetchDailyKlines(pair, 720),
  since: fetchDailyKlinesSince,
};

// [openTime, open, high, low, close, volume] — compact and lossless (closeTime is derived).
type Row = [number, number, number, number, number, number];

const toRow = (c: Candle): Row => [c.openTime, c.open, c.high, c.low, c.close, c.volume];
const fromRow = ([t, open, high, low, close, volume]: Row): Candle => ({
  openTime: t,
  open,
  high,
  low,
  close,
  volume,
  closeTime: t + DAY_MS - 1,
});

function isContinuous(rows: Row[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] - rows[i - 1][0] !== DAY_MS) return false;
  }
  return true;
}

export async function getDailyCandles(
  kv: KvLike,
  pair: Pair,
  limit = 210,
  nowMs: number = Date.now(),
  source: CandleSource = krakenSource,
): Promise<Candle[]> {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
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
    closed !== null && closed.length >= limit - 1 && closed[closed.length - 1][0] === today - DAY_MS && isContinuous(closed);

  if (usable && closed) {
    const fresh = await source.since(pair, today - 2 * DAY_MS);
    const forming = fresh.filter((c) => c.openTime >= today).at(-1);
    if (forming) return [...closed.slice(-(limit - 1)).map(fromRow), forming];
    // Kraken hasn't opened today's candle yet: serve what the old code would, leave the cache alone.
    return (await source.full(pair)).slice(-limit);
  }

  const all = await source.full(pair);
  const closedRows = all.filter((c) => c.openTime < today).slice(-(limit - 1)).map(toRow);
  const json = JSON.stringify(closedRows);
  if (json !== raw) await kv.put(cacheKey(pair), json); // skip the write if unchanged (KV write cap)
  return all.slice(-limit);
}

// Just the newest candle (forming one) — for commands that only need the current price.
export async function fetchLatestCandle(
  pair: Pair,
  nowMs: number = Date.now(),
  source: CandleSource = krakenSource,
): Promise<Candle> {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const last = (await source.since(pair, today - 2 * DAY_MS)).at(-1);
  if (!last) throw new Error("Kraken API: no recent candles");
  return last;
}
