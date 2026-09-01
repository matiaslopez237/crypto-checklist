import type { Indicators, Pair } from "../lib/types";

const LABELS: Record<Pair, string> = { BTCUSDT: "BTC/USDT", ETHUSDT: "ETH/USDT" };

function fmt(n: number | null, digits = 2) {
  return n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function PriceHeader({ pair, ind }: { pair: Pair; ind: Indicators }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{LABELS[pair]}</p>
      <p className="mt-1 text-3xl font-bold text-slate-900 dark:text-white">${fmt(ind.price)}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-600 dark:text-slate-300 sm:grid-cols-3">
        <div>SMA200: <span className="font-medium">${fmt(ind.sma200)}</span></div>
        <div>SMA50: <span className="font-medium">${fmt(ind.sma50)}</span></div>
        <div>RSI(14): <span className="font-medium">{fmt(ind.rsi14, 1)}</span></div>
        <div>Soporte 20d: <span className="font-medium">${fmt(ind.support20)}</span></div>
        <div>Resistencia 20d: <span className="font-medium">${fmt(ind.resistance20)}</span></div>
        <div>Var. 3d: <span className="font-medium">{fmt(ind.change3d, 1)}%</span></div>
      </div>
    </div>
  );
}
