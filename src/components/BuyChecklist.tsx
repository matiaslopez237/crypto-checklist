import type { BuyChecklistResult } from "../lib/types";
import { ChecklistRow } from "./ChecklistRow";

export function BuyChecklist({ result }: { result: BuyChecklistResult }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Checklist de compra</h2>
      <div className="flex flex-col gap-2">
        {result.items.map((item) => (
          <ChecklistRow key={item.label} item={item} />
        ))}
      </div>
    </section>
  );
}
