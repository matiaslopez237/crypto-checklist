import type { ChecklistItem } from "../lib/types";

export function ChecklistRow({ item }: { item: ChecklistItem }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
          item.passed
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
            : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400"
        }`}
      >
        {item.passed ? "✓" : "✕"}
      </span>
      <div>
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {item.label}
          {item.weight !== undefined && (
            <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              peso {item.weight}
            </span>
          )}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{item.detail}</p>
      </div>
    </div>
  );
}
