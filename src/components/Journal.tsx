import { useState } from "react";
import type { JournalEntry, Pair } from "../lib/types";
import { computeAveragePrices } from "../lib/journalStats";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function Journal({
  pair,
  entries,
  onAdd,
  onRemove,
}: {
  pair: Pair;
  entries: JournalEntry[];
  onAdd: (entry: JournalEntry) => void;
  onRemove: (id: string) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [date, setDate] = useState(todayISO());
  const [price, setPrice] = useState("");
  const [amountUsdt, setAmountUsdt] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const priceNum = Number(price);
    if (!priceNum || priceNum <= 0) return;
    const amountNum = Number(amountUsdt);
    onAdd({
      id: crypto.randomUUID(),
      pair,
      side,
      date,
      price: priceNum,
      amountUsdt: amountNum > 0 ? amountNum : null,
      reason,
      result,
    });
    setPrice("");
    setAmountUsdt("");
    setReason("");
    setResult("");
  }

  const { buy, sell } = computeAveragePrices(entries);

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Registro de operaciones</h2>

      <form
        onSubmit={handleSubmit}
        className="mb-3 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex gap-2">
          <div className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
            {(["buy", "sell"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  side === s
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {s === "buy" ? "Compra" : "Venta"}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
          />
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Precio"
            required
            className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
          />
          <input
            type="number"
            inputMode="decimal"
            value={amountUsdt}
            onChange={(e) => setAmountUsdt(e.target.value)}
            placeholder="Monto (USDT)"
            className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
          />
        </div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Motivo"
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
        />
        <input
          value={result}
          onChange={(e) => setResult(e.target.value)}
          placeholder="Resultado (opcional)"
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
        >
          Agregar
        </button>
      </form>

      {(buy.avgPrice !== null || sell.avgPrice !== null) && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500 dark:text-slate-400">Precio medio de compra</p>
            <p className="text-lg font-semibold text-slate-900 dark:text-white">
              {buy.avgPrice !== null ? `$${buy.avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
            </p>
            {buy.countMissingAmount > 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {buy.countMissingAmount} compra(s) sin monto, no incluida(s)
              </p>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3 text-center dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500 dark:text-slate-400">Precio medio de venta</p>
            <p className="text-lg font-semibold text-slate-900 dark:text-white">
              {sell.avgPrice !== null ? `$${sell.avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
            </p>
            {sell.countMissingAmount > 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {sell.countMissingAmount} venta(s) sin monto, no incluida(s)
              </p>
            )}
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Todavía no cargaste operaciones.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-2 py-2">Fecha</th>
                <th className="px-2 py-2">Par</th>
                <th className="px-2 py-2">Tipo</th>
                <th className="px-2 py-2">Precio</th>
                <th className="px-2 py-2">Monto (USDT)</th>
                <th className="px-2 py-2">Motivo</th>
                <th className="px-2 py-2">Resultado</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {entries.map((e) => (
                <tr key={e.id} className="text-slate-700 dark:text-slate-200">
                  <td className="px-2 py-2">{e.date}</td>
                  <td className="px-2 py-2">{e.pair}</td>
                  <td className="px-2 py-2">{e.side === "buy" ? "Compra" : "Venta"}</td>
                  <td className="px-2 py-2">${e.price.toLocaleString()}</td>
                  <td className="px-2 py-2">{e.amountUsdt != null ? `$${e.amountUsdt.toLocaleString()}` : "—"}</td>
                  <td className="px-2 py-2">{e.reason || "—"}</td>
                  <td className="px-2 py-2">{e.result || "—"}</td>
                  <td className="px-2 py-2">
                    <button
                      onClick={() => onRemove(e.id)}
                      className="text-rose-600 hover:underline dark:text-rose-400"
                    >
                      Borrar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
