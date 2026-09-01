import type { Verdict } from "../lib/types";

const CONFIG: Record<Verdict, { label: string; classes: string }> = {
  buy: { label: "Entrada razonable", classes: "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700" },
  watch: { label: "Zona dudosa", classes: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700" },
  avoid: { label: "No conviene", classes: "bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-700" },
};

export function VerdictBanner({ verdict, score, maxScore }: { verdict: Verdict; score: number; maxScore: number }) {
  const { label, classes } = CONFIG[verdict];
  const pct = Math.round((score / maxScore) * 100);
  return (
    <div className={`rounded-2xl border-2 px-4 py-5 text-center ${classes}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">Veredicto</p>
      <p className="mt-1 text-2xl font-bold">{label}</p>
      <p className="mt-1 text-sm opacity-80">
        {score} de {maxScore} puntos ({pct}%)
      </p>
    </div>
  );
}
