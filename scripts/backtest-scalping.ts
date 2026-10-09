// Backtest of simple long-only spot scalping strategies on 1-minute Binance candles,
// sized for a tiny real account (Binance's 5 USDT minimum order caps how many
// positions fit). Exploratory only — not wired into either Worker. Run with:
//   npx tsx scripts/backtest-scalping.ts
// Env overrides: DAYS=180 FEE_PCT=0.1 START_CASH=15.84
import type { Candle } from "../src/lib/types";
import { getHistory } from "./binanceHistory";

const COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
const DAYS = Number(process.env.DAYS ?? 180);
const FEE_PCT = Number(process.env.FEE_PCT ?? 0.1); // per leg, Binance spot taker
const START_CASH = Number(process.env.START_CASH ?? 15.84);
const MIN_NOTIONAL = 5; // Binance spot minimum order, USDT
const MAX_POSITIONS = 3;
const TIME_STOP_MIN = Number(process.env.TIME_STOP_MIN ?? 120);

interface Series {
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  ema20: Float64Array;
  ema50: Float64Array;
  ema200: Float64Array;
  rsi14: Float64Array;
  rsi7: Float64Array;
  bbLower: Float64Array;
  high60: Float64Array; // max high of the previous 60 candles (excluding current)
  volAvg20: Float64Array; // avg volume of the previous 20 candles (excluding current)
}

function ema(close: Float64Array, n: number): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  const a = 2 / (n + 1);
  let sum = 0;
  for (let i = 0; i < close.length; i++) {
    if (i < n) {
      sum += close[i];
      if (i === n - 1) out[i] = sum / n;
      continue;
    }
    out[i] = a * close[i] + (1 - a) * out[i - 1];
  }
  return out;
}

// Wilder's RSI, same formula as src/lib/indicators.ts, computed incrementally.
function rsi(close: Float64Array, n: number): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i <= n) {
      gain += g;
      loss += l;
      if (i === n) {
        gain /= n;
        loss /= n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
      continue;
    }
    gain = (gain * (n - 1) + g) / n;
    loss = (loss * (n - 1) + l) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function buildSeries(candles: Candle[]): Series {
  const len = candles.length;
  const f = (k: keyof Candle) => Float64Array.from(candles, (c) => c[k] as number);
  const close = f("close");
  const high = f("high");
  const volume = f("volume");

  const bbLower = new Float64Array(len).fill(NaN);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    s += close[i];
    s2 += close[i] * close[i];
    if (i >= 20) {
      s -= close[i - 20];
      s2 -= close[i - 20] * close[i - 20];
    }
    if (i >= 19) {
      const mean = s / 20;
      const sd = Math.sqrt(Math.max(0, s2 / 20 - mean * mean));
      bbLower[i] = mean - 2 * sd;
    }
  }

  const high60 = new Float64Array(len).fill(NaN);
  const volAvg20 = new Float64Array(len).fill(NaN);
  let vs = 0;
  for (let i = 0; i < len; i++) {
    if (i >= 60) {
      let m = -Infinity;
      for (let j = i - 60; j < i; j++) if (high[j] > m) m = high[j];
      high60[i] = m;
    }
    if (i >= 20) volAvg20[i] = vs / 20;
    vs += volume[i];
    if (i >= 20) vs -= volume[i - 20];
  }

  return {
    open: f("open"),
    high,
    low: f("low"),
    close,
    volume,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi14: rsi(close, 14),
    rsi7: rsi(close, 7),
    bbLower,
    high60,
    volAvg20,
  };
}

type Signal = (s: Series, i: number) => boolean;

const STRATEGIES: Record<string, Signal> = {
  // Oversold bounce, only with the 1m trend still up.
  "Rebote (RSI14<25 bajo Bollinger, sobre EMA200)": (s, i) =>
    s.rsi14[i] < 25 && s.close[i] < s.bbLower[i] && s.close[i] > s.ema200[i],
  // Short pullback inside an established uptrend.
  "Retroceso (RSI7<25 con EMA50>EMA200)": (s, i) => s.rsi7[i] < 25 && s.ema50[i] > s.ema200[i] && s.close[i] > s.ema200[i],
  // Breakout of the last hour's high on a volume spike.
  "Ruptura (máximo de 60 min + volumen x2)": (s, i) => s.close[i] > s.high60[i] && s.volume[i] > 2 * s.volAvg20[i],
};

const EXITS_DEFAULT = [
  { tp: 0.3, sl: 0.3 },
  { tp: 0.5, sl: 0.5 },
  { tp: 1.0, sl: 0.5 },
  { tp: 1.0, sl: 1.0 },
];

// EXITS="2:1,3:1.5" overrides the target:stop pairs (percent).
const EXITS = process.env.EXITS
  ? process.env.EXITS.split(",").map((p) => { const [tp, sl] = p.split(":").map(Number); return { tp, sl }; })
  : EXITS_DEFAULT;

interface Position {
  qty: number;
  entry: number;
  entryIdx: number;
  cost: number;
}

interface Result {
  finalEquity: number;
  maxDD: number;
  trades: number;
  wins: number;
  feesPaid: number;
  skippedNoCash: number;
}

function run(series: Series[], len: number, signal: Signal, tp: number, sl: number): Result {
  const fee = FEE_PCT / 100;
  let cash = START_CASH;
  const pos: (Position | null)[] = series.map(() => null);
  let peak = START_CASH;
  let maxDD = 0;
  let trades = 0;
  let wins = 0;
  let feesPaid = 0;
  let skippedNoCash = 0;
  const pending: boolean[] = series.map(() => false);

  for (let i = 200; i < len; i++) {
    for (let c = 0; c < series.length; c++) {
      const s = series[c];

      // Signal from candle i-1's close enters at candle i's open (no lookahead).
      if (pending[c]) {
        pending[c] = false;
        const open = pos.filter(Boolean).length;
        let equity = cash;
        for (let k = 0; k < series.length; k++) if (pos[k]) equity += pos[k]!.qty * series[k].open[i];
        const size = Math.min(cash, Math.max(MIN_NOTIONAL, equity / MAX_POSITIONS));
        if (!pos[c] && open < MAX_POSITIONS && size >= MIN_NOTIONAL) {
          const price = s.open[i];
          const qty = (size * (1 - fee)) / price;
          feesPaid += size * fee;
          cash -= size;
          pos[c] = { qty, entry: price, entryIdx: i, cost: size };
        } else if (!pos[c]) {
          skippedNoCash++;
        }
      }

      const p = pos[c];
      if (p) {
        const slPrice = p.entry * (1 - sl / 100);
        const tpPrice = p.entry * (1 + tp / 100);
        let exit: number | null = null;
        // Conservative: if a candle touches both, assume the stop hit first.
        if (s.open[i] <= slPrice) exit = s.open[i];
        else if (s.low[i] <= slPrice) exit = slPrice;
        else if (s.open[i] >= tpPrice) exit = s.open[i];
        else if (s.high[i] >= tpPrice) exit = tpPrice;
        else if (i - p.entryIdx >= TIME_STOP_MIN) exit = s.close[i];
        if (exit !== null) {
          const gross = p.qty * exit;
          feesPaid += gross * fee;
          const proceeds = gross * (1 - fee);
          cash += proceeds;
          trades++;
          if (proceeds > p.cost) wins++;
          pos[c] = null;
        }
      }

      if (!pos[c] && signal(s, i)) pending[c] = true;
    }

    let equity = cash;
    for (let k = 0; k < series.length; k++) if (pos[k]) equity += pos[k]!.qty * series[k].close[i];
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  let finalEquity = cash;
  for (let k = 0; k < series.length; k++) if (pos[k]) finalEquity += pos[k]!.qty * series[k].close[len - 1];
  return { finalEquity, maxDD: maxDD * 100, trades, wins, feesPaid, skippedNoCash };
}

async function main() {
  const start = Math.floor((Date.now() - DAYS * 86_400_000) / 86_400_000) * 86_400_000;
  console.log(`Descargando velas de 1 minuto (${DAYS} días, Binance, cache local)...`);
  const raw: Candle[][] = [];
  for (const coin of COINS) raw.push(await getHistory(coin, "1m", start));

  // Align all coins on the timestamps they share.
  const common = raw.map((r) => new Set(r.map((c) => c.openTime))).reduce((a, b) => new Set([...a].filter((t) => b.has(t))));
  const aligned = raw.map((r) => r.filter((c) => common.has(c.openTime)));
  const len = aligned[0].length;
  const series = aligned.map(buildSeries);
  console.log(
    `Período: ${new Date(aligned[0][0].openTime).toISOString().slice(0, 10)} a ${new Date(aligned[0][len - 1].openTime).toISOString().slice(0, 10)} — ${len.toLocaleString()} minutos, ${COINS.length} monedas`,
  );
  console.log(`Capital $${START_CASH}, comisión ${FEE_PCT}% por lado, máx ${MAX_POSITIONS} posiciones, mínimo $${MIN_NOTIONAL}, salida forzada a los ${TIME_STOP_MIN} min\n`);

  let bh = 0;
  for (const s of series) bh += (START_CASH / series.length) * (s.close[len - 1] / s.open[200]);
  console.log(`Referencia — comprar y guardar las 4 monedas en partes iguales: ${(((bh - START_CASH) / START_CASH) * 100).toFixed(1)}%\n`);

  for (const [name, signal] of Object.entries(STRATEGIES)) {
    console.log(`=== ${name} ===`);
    for (const { tp, sl } of EXITS) {
      const r = run(series, len, signal, tp, sl);
      const ret = ((r.finalEquity - START_CASH) / START_CASH) * 100;
      const winRate = r.trades ? ((r.wins / r.trades) * 100).toFixed(0) : "-";
      console.log(
        `  objetivo +${tp}% / stop -${sl}%: ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}% · caída máx ${r.maxDD.toFixed(1)}% · ${r.trades} operaciones · aciertos ${winRate}% · comisiones pagadas $${r.feesPaid.toFixed(2)}`,
      );
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
