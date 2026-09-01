import { useCallback, useEffect, useState } from "react";
import { fetchDailyKlines } from "./lib/binance";
import { computeIndicators } from "./lib/indicators";
import { buildBuyChecklist, buildSellChecklist } from "./lib/checklist";
import { addJournalEntry, loadJournal, removeJournalEntry } from "./lib/storage";
import { computeOpenPosition } from "./lib/journalStats";
import type { Candle, Indicators, JournalEntry, Pair } from "./lib/types";
import { PairSelector } from "./components/PairSelector";
import { PriceHeader } from "./components/PriceHeader";
import { VerdictBanner } from "./components/VerdictBanner";
import { BuyChecklist } from "./components/BuyChecklist";
import { SellChecklist } from "./components/SellChecklist";
import { Journal } from "./components/Journal";

function App() {
  const [pair, setPair] = useState<Pair>("BTCUSDT");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [entryPriceMode, setEntryPriceMode] = useState<"auto" | "manual">("auto");
  const [manualEntryPrice, setManualEntryPrice] = useState("");
  const [stopLossPct, setStopLossPct] = useState("10");
  const [takeProfitPct, setTakeProfitPct] = useState("20");
  const [feePct, setFeePct] = useState("0.1");

  const [journal, setJournal] = useState<JournalEntry[]>([]);

  useEffect(() => {
    setJournal(loadJournal());
  }, []);

  // Switching pairs starts fresh: default back to the auto-computed entry price for that pair.
  useEffect(() => {
    setEntryPriceMode("auto");
    setManualEntryPrice("");
  }, [pair]);

  const load = useCallback(async (p: Pair) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDailyKlines(p, 210);
      setCandles(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido al traer datos de Binance");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(pair);
  }, [pair, load]);

  const ind: Indicators | null = candles && candles.length > 0 ? computeIndicators(candles) : null;
  const buyResult = ind ? buildBuyChecklist(ind) : null;

  const pairEntries = journal.filter((e) => e.pair === pair);
  const position = computeOpenPosition(pairEntries);
  const hasAutoPosition = position.qty > 0 && position.avgBuyPrice !== null;

  const entryPriceNum =
    entryPriceMode === "auto" && hasAutoPosition ? (position.avgBuyPrice as number) : Number(manualEntryPrice);
  const stopLossNum = Number(stopLossPct) || 10;
  const takeProfitNum = Number(takeProfitPct) || 20;
  const feeNum = feePct === "" ? 0 : Number(feePct) || 0;
  const sellResult =
    ind && entryPriceNum > 0 ? buildSellChecklist(ind, entryPriceNum, stopLossNum, feeNum, takeProfitNum) : null;
  const positionValueUsdt = ind && hasAutoPosition ? position.qty * ind.price : null;

  function handleAddEntry(entry: JournalEntry) {
    setJournal(addJournalEntry(entry));
  }

  function handleRemoveEntry(id: string) {
    setJournal(removeJournalEntry(id));
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-lg flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-lg font-bold text-slate-900 dark:text-white">Checklist BTC/ETH</h1>
        <PairSelector pair={pair} onChange={setPair} onRefresh={() => load(pair)} loading={loading} />
      </header>

      {error && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
          {error}
        </div>
      )}

      {!ind && !error && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Cargando datos de Binance…
        </div>
      )}

      {ind && buyResult && (
        <>
          <VerdictBanner verdict={buyResult.verdict} score={buyResult.score} maxScore={buyResult.maxScore} />
          <PriceHeader pair={pair} ind={ind} />
          <BuyChecklist result={buyResult} />
          <SellChecklist
            position={position}
            positionValueUsdt={positionValueUsdt}
            entryPriceMode={entryPriceMode}
            onUseAutoPrice={() => setEntryPriceMode("auto")}
            onEditManual={() => setEntryPriceMode("manual")}
            manualEntryPrice={manualEntryPrice}
            onManualEntryPriceChange={(v) => {
              setManualEntryPrice(v);
              setEntryPriceMode("manual");
            }}
            stopLossPct={stopLossPct}
            onStopLossPctChange={setStopLossPct}
            takeProfitPct={takeProfitPct}
            onTakeProfitPctChange={setTakeProfitPct}
            feePct={feePct}
            onFeePctChange={setFeePct}
            result={sellResult}
          />
          <Journal
            pair={pair}
            entries={pairEntries}
            onAdd={handleAddEntry}
            onRemove={handleRemoveEntry}
          />
        </>
      )}
    </div>
  );
}

export default App;
