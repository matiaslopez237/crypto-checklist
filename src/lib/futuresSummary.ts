import { fmt } from "./telegramCommands";
import { computeEquity, unrealizedPnl } from "./futuresEngine";
import { FUTURES_PAIR_LABELS, STARTING_CASH, type FuturesPair, type FuturesSimFile, type VariantKey } from "./futuresTypes";

const VARIANT_LABELS: Record<VariantKey, string> = {
  "A-2x": "Variante A (2x, todo al objetivo)",
  "B-2x": "Variante B (2x, 50% + trailing)",
  "B-3x": "Variante B (3x, 50% + trailing)",
};

export function buildFuturesSummary(file: FuturesSimFile, prices: Partial<Record<FuturesPair, number>>): string {
  const blocks = (Object.keys(VARIANT_LABELS) as VariantKey[]).map((key) => {
    const variant = file[key];
    const equity = computeEquity(variant, prices);
    const pctReturn = ((equity - STARTING_CASH) / STARTING_CASH) * 100;
    const closed = variant.trades.length;
    const wins = variant.trades.filter((t) => t.pnlUsd > 0).length;
    const winRate = closed > 0 ? (wins / closed) * 100 : null;
    const realizedPnl = variant.trades.reduce((sum, t) => sum + t.pnlUsd, 0);

    const posLines = (Object.entries(variant.positions) as [FuturesPair, (typeof variant.positions)[FuturesPair]][])
      .filter(([, pos]) => pos)
      .map(([pair, pos]) => {
        const p = pos!;
        const price = prices[pair];
        const sideLabel = p.side === "long" ? "long" : "short";
        const moveText =
          price !== undefined
            ? ` · PnL: ${unrealizedPnl(p, price) >= 0 ? "+" : ""}$${fmt(unrealizedPnl(p, price))}`
            : "";
        return `  ${FUTURES_PAIR_LABELS[pair]} ${sideLabel} @ $${fmt(p.entryPrice)}${p.partialTaken ? " (parcial tomado)" : ""}${moveText}`;
      });

    const status = variant.paused ? " · ⏸ pausada" : "";
    return (
      `<b>${VARIANT_LABELS[key]}</b>${status}\n` +
      `Equity: $${fmt(equity)} de $${fmt(STARTING_CASH)} (${pctReturn >= 0 ? "+" : ""}${pctReturn.toFixed(1)}%)\n` +
      `Operaciones cerradas: ${closed}${winRate !== null ? ` · aciertos: ${winRate.toFixed(0)}%` : ""} · PnL realizado: ${realizedPnl >= 0 ? "+" : ""}$${fmt(realizedPnl)}` +
      (variant.blockedCount > 0 ? ` · bloqueadas por frenos: ${variant.blockedCount}` : "") +
      (posLines.length > 0 ? `\n${posLines.join("\n")}` : "\nSin posiciones abiertas")
    );
  });

  return `📊 <b>Simulación de futuros</b>\n\n${blocks.join("\n\n")}`;
}
