import type { OpenPosition } from "../lib/journalStats";
import type { SellChecklistResult } from "../lib/types";
import { ChecklistRow } from "./ChecklistRow";

function fmtUsd(n: number, digits = 2) {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function SellChecklist({
  position,
  positionValueUsdt,
  entryPriceMode,
  onUseAutoPrice,
  onEditManual,
  manualEntryPrice,
  onManualEntryPriceChange,
  stopLossPct,
  onStopLossPctChange,
  takeProfitPct,
  onTakeProfitPctChange,
  feePct,
  onFeePctChange,
  result,
}: {
  position: OpenPosition;
  positionValueUsdt: number | null;
  entryPriceMode: "auto" | "manual";
  onUseAutoPrice: () => void;
  onEditManual: () => void;
  manualEntryPrice: string;
  onManualEntryPriceChange: (v: string) => void;
  stopLossPct: string;
  onStopLossPctChange: (v: string) => void;
  takeProfitPct: string;
  onTakeProfitPctChange: (v: string) => void;
  feePct: string;
  onFeePctChange: (v: string) => void;
  result: SellChecklistResult | null;
}) {
  const hasAutoPosition = position.qty > 0 && position.avgBuyPrice !== null;
  const showAuto = hasAutoPosition && entryPriceMode === "auto";

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Checklist de venta</h2>

      {hasAutoPosition && (
        <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          <p className="font-medium text-slate-900 dark:text-white">
            Tenés acumulado: {position.qty.toFixed(6)} (según tus compras cargadas)
          </p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">
            Precio promedio de compra: ${fmtUsd(position.avgBuyPrice as number)} · costo total: ${fmtUsd(position.costUsdt)}
          </p>
          {positionValueUsdt !== null && (
            <p className="text-slate-600 dark:text-slate-300">Valor actual: ${fmtUsd(positionValueUsdt)}</p>
          )}
          {position.missingAmountCount > 0 && (
            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
              {position.missingAmountCount} operación(es) sin monto en USDT no se incluyeron en esta cuenta.
            </p>
          )}
        </div>
      )}

      <div className="mb-3 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        {showAuto ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600 dark:text-slate-300">
              Usando precio de entrada: <span className="font-semibold text-slate-900 dark:text-white">${fmtUsd(position.avgBuyPrice as number)}</span>{" "}
              (promedio de tus compras)
            </span>
            <button
              type="button"
              onClick={onEditManual}
              className="shrink-0 text-xs font-medium text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            >
              Editar manualmente
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex-1 text-sm text-slate-600 dark:text-slate-300">
              Precio de entrada
              <input
                type="number"
                inputMode="decimal"
                value={manualEntryPrice}
                onChange={(e) => onManualEntryPriceChange(e.target.value)}
                placeholder="Ej: 65000"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
            {hasAutoPosition && (
              <button
                type="button"
                onClick={onUseAutoPrice}
                className="self-start whitespace-nowrap text-xs font-medium text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-white sm:self-end sm:pb-2"
              >
                Usar precio de mis compras
              </button>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex-1 text-sm text-slate-600 dark:text-slate-300">
            Stop loss (%)
            <input
              type="number"
              inputMode="decimal"
              value={stopLossPct}
              onChange={(e) => onStopLossPctChange(e.target.value)}
              placeholder="10"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label className="flex-1 text-sm text-slate-600 dark:text-slate-300">
            Take profit (%)
            <input
              type="number"
              inputMode="decimal"
              value={takeProfitPct}
              onChange={(e) => onTakeProfitPctChange(e.target.value)}
              placeholder="20"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label className="flex-1 text-sm text-slate-600 dark:text-slate-300">
            Comisión por operación (%)
            <input
              type="number"
              inputMode="decimal"
              value={feePct}
              onChange={(e) => onFeePctChange(e.target.value)}
              placeholder="0.1"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
        </div>
      </div>

      {result ? (
        <div className="flex flex-col gap-2">
          <div
            className={`rounded-xl border p-3 text-center text-sm font-semibold ${
              result.pnlPct >= 0
                ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
            }`}
          >
            PnL neto: {result.pnlPct >= 0 ? "+" : ""}
            {result.pnlPct.toFixed(1)}%
            <span className="block text-xs font-normal opacity-70">
              (bruto: {result.grossPnlPct >= 0 ? "+" : ""}
              {result.grossPnlPct.toFixed(1)}%, antes de comisiones)
            </span>
          </div>
          <ChecklistRow item={result.overbought} />
          <ChecklistRow item={result.nearResistance} />
          <ChecklistRow item={result.trendBreak} />
          <ChecklistRow item={result.takeProfit} />
          <ChecklistRow item={result.stopLoss} />
        </div>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Cargá una compra en el registro de operaciones (con monto en USDT) o un precio de entrada manual para ver el análisis
          de venta.
        </p>
      )}
    </section>
  );
}
