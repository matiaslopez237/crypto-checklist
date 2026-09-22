// Historical candle fetcher for backtesting — runs locally (this is a dev-only tool,
// never imported by either Worker), so it can use Binance's public API directly, which
// gives far more history than Kraken's public OHLC endpoint (always caps at the most
// recent ~720 candles, confirmed empirically — no way to page further into the past).
// Binance's klines endpoint pages properly via startTime + limit=1000.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, ".cache");

type BinanceInterval = "1d" | "1h";

interface BinanceKlineRow extends Array<number | string> {
  0: number; // open time
  1: string; // open
  2: string; // high
  3: string; // low
  4: string; // close
  5: string; // volume
  6: number; // close time
}

async function fetchKlinesPage(symbol: string, interval: BinanceInterval, startTime: number): Promise<BinanceKlineRow[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error (${res.status}) para ${symbol} ${interval}`);
  return (await res.json()) as BinanceKlineRow[];
}

function toCandle(row: BinanceKlineRow): Candle {
  return {
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
  };
}

// Fetches every candle from `startTime` to now, paginating in pages of 1000.
async function fetchFullHistory(symbol: string, interval: BinanceInterval, startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;
  for (;;) {
    const page = await fetchKlinesPage(symbol, interval, cursor);
    if (page.length === 0) break;
    all.push(...page.map(toCandle));
    const lastOpen = page[page.length - 1][0];
    if (page.length < 1000) break; // last page
    cursor = lastOpen + 1;
    await new Promise((r) => setTimeout(r, 150)); // be polite to Binance's public API
  }
  return all;
}

// Caches to a local JSON file so re-running a backtest doesn't re-fetch years of data
// every time — delete the .cache folder (or the one file) to force a refresh.
export async function getHistory(symbol: string, interval: BinanceInterval, startTime: number): Promise<Candle[]> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, `${symbol}_${interval}_${startTime}.json`);

  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf-8")) as Candle[];
    // Refresh only if the cache is more than a day stale, so results stay current
    // without re-downloading years of history on every run.
    const lastCandleAge = Date.now() - cached[cached.length - 1].openTime;
    if (lastCandleAge < 2 * 86_400_000) return cached;
  }

  console.log(`  descargando ${symbol} ${interval} desde ${new Date(startTime).toISOString().slice(0, 10)}...`);
  const history = await fetchFullHistory(symbol, interval, startTime);
  writeFileSync(cacheFile, JSON.stringify(history));
  console.log(`  ${history.length} velas guardadas en cache`);
  return history;
}
