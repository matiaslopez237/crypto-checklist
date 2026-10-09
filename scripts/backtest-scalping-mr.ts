// Mean-reversion scalping on 5-minute candles with a 1-hour trend filter, swept over
// a parameter grid with a walk-forward split: parameters are chosen on the first half
// of the data and then evaluated, untouched, on the second half. Exploratory only —
// not wired into either Worker. Run with:
//   npx tsx scripts/backtest-scalping-mr.ts        (env: DAYS=730)
import type { Candle } from "../src/lib/types";
import { getHistory } from "./binanceHistory";

const COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
const DAYS = Number(process.env.DAYS ?? 730);
const HOUR = 3_600_000;

interface Series {
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  mid: Float64Array; // 20-period SMA (Bollinger middle)
  sd: Float64Array; // 20-period standard deviation
  rsi: Float64Array; // RSI(14)
  trend: Int8Array; // 1h EMA50 vs EMA200 from completed hours only: 1 up, -1 down, 0 unknown
}

function rsi14(close: Float64Array): Float64Array {
  const n = 14;
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

function buildSeries(c: Candle[]): Series {
  const len = c.length;
  const close = Float64Array.from(c, (x) => x.close);
  const mid = new Float64Array(len).fill(NaN);
  const sd = new Float64Array(len).fill(NaN);
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
      mid[i] = s / 20;
      sd[i] = Math.sqrt(Math.max(0, s2 / 20 - mid[i] * mid[i]));
    }
  }

  // Hourly EMAs updated only when an hour closes, so a 5m candle never sees its own hour.
  const trend = new Int8Array(len);
  const a50 = 2 / 51;
  const a200 = 2 / 201;
  let e50 = NaN;
  let e200 = NaN;
  let hours = 0;
  let curHour = Math.floor(c[0].openTime / HOUR);
  let lastClose = close[0];
  let state = 0;
  for (let i = 0; i < len; i++) {
    const h = Math.floor(c[i].openTime / HOUR);
    if (h !== curHour) {
      hours++;
      e50 = hours === 1 ? lastClose : a50 * lastClose + (1 - a50) * e50;
      e200 = hours === 1 ? lastClose : a200 * lastClose + (1 - a200) * e200;
      state = hours >= 200 ? (e50 > e200 ? 1 : -1) : 0;
      curHour = h;
    }
    trend[i] = state;
    lastClose = close[i];
  }

  return {
    open: Float64Array.from(c, (x) => x.open),
    high: Float64Array.from(c, (x) => x.high),
    low: Float64Array.from(c, (x) => x.low),
    close,
    mid,
    sd,
    rsi: rsi14(close),
    trend,
  };
}

interface Params {
  k: number; // Bollinger width for the entry
  rsiMax: number; // long entry needs RSI below this (short: above 100 - rsiMax)
  useTrend: boolean;
  exit: "mean" | number; // back to the Bollinger middle, or a fixed target %
  sl: number; // stop %
  maxBars: number; // time stop, in 5m candles
  shorts: boolean;
}

interface Fees {
  name: string;
  entry: number; // %
  target: number; // % on exits at the mean / target (limit orders)
  stop: number; // % on stop / time exits (market orders)
}

const FEE_MODELS: Fees[] = [
  { name: "Spot (0.1% por lado)", entry: 0.1, target: 0.1, stop: 0.1 },
  { name: "Futuros con órdenes limit (0.02% maker / 0.05% stop)", entry: 0.02, target: 0.02, stop: 0.05 },
];

interface Result {
  ret: number;
  maxDD: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  avgTrade: number;
}

// Each coin trades its own quarter of the account (full slot per trade, compounding).
function run(series: Series[], from: number, to: number, p: Params, f: Fees): Result {
  const n = series.length;
  const cash = new Float64Array(n).fill(1 / n);
  const side = new Int8Array(n); // 0 flat, 1 long, -1 short
  const entry = new Float64Array(n);
  const base = new Float64Array(n); // slot value right after the entry fee
  const entryIdx = new Int32Array(n);
  const pending = new Int8Array(n);
  let peak = 1;
  let maxDD = 0;
  let trades = 0;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let sumRet = 0;

  const start = Math.max(from, 250);
  for (let i = start; i < to; i++) {
    let equity = 0;
    for (let c = 0; c < n; c++) {
      const s = series[c];

      if (pending[c] !== 0) {
        side[c] = pending[c];
        pending[c] = 0;
        entry[c] = s.open[i];
        base[c] = cash[c] * (1 - f.entry / 100);
        entryIdx[c] = i;
      }

      if (side[c] !== 0) {
        const dir = side[c];
        const e = entry[c];
        const slPx = e * (1 - (dir * p.sl) / 100);
        const tgtPx = p.exit === "mean" ? s.mid[i - 1] : e * (1 + (dir * p.exit) / 100);
        let exitPx = NaN;
        let fee = f.stop;
        const hitStop = dir === 1 ? s.low[i] <= slPx : s.high[i] >= slPx;
        const hitTgt = dir === 1 ? s.high[i] >= tgtPx : s.low[i] <= tgtPx;
        // Conservative: a candle that touches both counts as a stop.
        if (hitStop) exitPx = dir === 1 ? Math.min(s.open[i], slPx) : Math.max(s.open[i], slPx);
        else if (hitTgt) {
          exitPx = dir === 1 ? Math.max(s.open[i], tgtPx) : Math.min(s.open[i], tgtPx);
          fee = f.target;
        } else if (i - entryIdx[c] >= p.maxBars) exitPx = s.close[i];

        if (!Number.isNaN(exitPx)) {
          const value = base[c] * (dir === 1 ? exitPx / e : 2 - exitPx / e) * (1 - fee / 100);
          const r = value / cash[c] - 1;
          trades++;
          sumRet += r;
          if (r > 0) {
            wins++;
            grossWin += r;
          } else grossLoss -= r;
          cash[c] = value;
          side[c] = 0;
        }
      }

      if (side[c] === 0 && i + 1 < to) {
        const lower = s.mid[i] - p.k * s.sd[i];
        const upper = s.mid[i] + p.k * s.sd[i];
        const longOk = s.close[i] < lower && s.rsi[i] < p.rsiMax && (!p.useTrend || s.trend[i] === 1);
        const shortOk = p.shorts && s.close[i] > upper && s.rsi[i] > 100 - p.rsiMax && (!p.useTrend || s.trend[i] === -1);
        if (longOk) pending[c] = 1;
        else if (shortOk) pending[c] = -1;
      }

      equity += side[c] === 0 ? cash[c] : base[c] * (side[c] === 1 ? s.close[i] / entry[c] : 2 - s.close[i] / entry[c]);
    }
    if (equity > peak) peak = equity;
    const dd = equity / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }

  let final = 0;
  for (let c = 0; c < n; c++) {
    const s = series[c];
    final += side[c] === 0 ? cash[c] : base[c] * (side[c] === 1 ? s.close[to - 1] / entry[c] : 2 - s.close[to - 1] / entry[c]);
  }
  return {
    ret: (final - 1) * 100,
    maxDD: maxDD * 100,
    trades,
    winRate: trades ? (wins / trades) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    avgTrade: trades ? (sumRet / trades) * 100 : 0,
  };
}

function grid(): Params[] {
  const out: Params[] = [];
  for (const k of [2, 2.5, 3])
    for (const rsiMax of [20, 25, 30])
      for (const useTrend of [true, false])
        for (const exit of ["mean", 0.5, 1, 1.5] as const)
          for (const sl of [0.5, 1, 1.5])
            for (const maxBars of [12, 48])
              for (const shorts of [false, true]) out.push({ k, rsiMax, useTrend, exit, sl, maxBars, shorts });
  return out;
}

const describe = (p: Params) =>
  `Bollinger ${p.k} · RSI<${p.rsiMax} · tendencia 1h ${p.useTrend ? "sí" : "no"} · salida ${p.exit === "mean" ? "al promedio" : `+${p.exit}%`} · stop -${p.sl}% · máx ${p.maxBars * 5} min · ${p.shorts ? "long+short" : "solo long"}`;

const fmt = (r: Result) =>
  `${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(1)}% · caída máx ${r.maxDD.toFixed(1)}% · ${r.trades} op · aciertos ${r.winRate.toFixed(0)}% · factor de ganancia ${r.profitFactor.toFixed(2)} · promedio por op ${r.avgTrade >= 0 ? "+" : ""}${r.avgTrade.toFixed(3)}%`;

function buyHold(series: Series[], from: number, to: number): number {
  let v = 0;
  for (const s of series) v += s.close[to - 1] / s.open[Math.max(from, 250)] / series.length;
  return (v - 1) * 100;
}

async function main() {
  const start = Math.floor((Date.now() - DAYS * 86_400_000) / 86_400_000) * 86_400_000;
  console.log(`Descargando velas de 5 minutos (${DAYS} días, Binance, cache local)...`);
  const raw: Candle[][] = [];
  for (const coin of COINS) raw.push(await getHistory(coin, "5m", start));

  const common = raw.map((r) => new Set(r.map((c) => c.openTime))).reduce((a, b) => new Set([...a].filter((t) => b.has(t))));
  const aligned = raw.map((r) => r.filter((c) => common.has(c.openTime)));
  const len = aligned[0].length;
  const split = Math.floor(len / 2);
  const day = (i: number) => new Date(aligned[0][i].openTime).toISOString().slice(0, 10);
  const series = aligned.map(buildSeries);

  console.log(`Entrenamiento (elegir parámetros): ${day(0)} a ${day(split - 1)}`);
  console.log(`Prueba a ciegas:                   ${day(split)} a ${day(len - 1)}`);
  console.log(
    `Comprar y guardar (4 monedas en partes iguales): entrenamiento ${buyHold(series, 0, split).toFixed(1)}% · prueba ${buyHold(series, split, len).toFixed(1)}%\n`,
  );

  const params = grid();
  for (const fees of FEE_MODELS) {
    console.log(`################ ${fees.name} — ${params.length} combinaciones ################`);
    const scored = params
      .map((p) => ({ p, train: run(series, 0, split, p, fees) }))
      .filter((x) => x.train.trades >= 100 && x.train.maxDD > -25)
      .sort((a, b) => b.train.ret - a.train.ret);

    const positiveTrain = scored.filter((x) => x.train.ret > 0).length;
    console.log(`Combinaciones con ≥100 operaciones y caída < 25%: ${scored.length} · con ganancia en entrenamiento: ${positiveTrain}`);

    console.log("\nTop 5 del entrenamiento, y cómo les fue después en la prueba a ciegas:");
    for (const { p, train } of scored.slice(0, 5)) {
      const test = run(series, split, len, p, fees);
      console.log(`- ${describe(p)}`);
      console.log(`    entrenamiento: ${fmt(train)}`);
      console.log(`    prueba a ciegas: ${fmt(test)}`);
    }

    const testPositive = scored.slice(0, 20).filter((x) => run(series, split, len, x.p, fees).ret > 0).length;
    console.log(`\nDe las 20 mejores del entrenamiento, ganaron también en la prueba a ciegas: ${testPositive}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
