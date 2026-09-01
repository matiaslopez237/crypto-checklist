import type { Candle, Indicators } from "./types";

export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// Wilder's smoothed RSI(14) — the standard used across trading platforms.
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function support20(closes: number[]): number {
  const slice = closes.slice(-20);
  return Math.min(...slice);
}

export function resistance20(closes: number[]): number {
  const slice = closes.slice(-20);
  return Math.max(...slice);
}

export function change3d(closes: number[]): number | null {
  if (closes.length < 4) return null;
  const current = closes[closes.length - 1];
  const threeDaysAgo = closes[closes.length - 4];
  return ((current - threeDaysAgo) / threeDaysAgo) * 100;
}

// Binance's last daily candle is often still "in progress" (today, not yet closed).
// Comparing its partial volume against a 20-day average of full days would be
// unfair, so volume stats are anchored to the most recently *closed* candle.
export function volumeStats(candles: Candle[]): { lastVolume: number; avgVolume20: number | null } {
  if (candles.length === 0) return { lastVolume: 0, avgVolume20: null };

  const lastIsOpen = candles[candles.length - 1].closeTime > Date.now();
  const lastClosedIndex = lastIsOpen ? candles.length - 2 : candles.length - 1;

  if (lastClosedIndex < 0) {
    return { lastVolume: candles[candles.length - 1].volume, avgVolume20: null };
  }

  const lastVolume = candles[lastClosedIndex].volume;
  const windowStart = Math.max(0, lastClosedIndex - 19);
  const window = candles.slice(windowStart, lastClosedIndex + 1);
  const avgVolume20 = window.length > 0 ? window.reduce((sum, c) => sum + c.volume, 0) / window.length : null;

  return { lastVolume, avgVolume20 };
}

export function computeIndicators(candles: Candle[]): Indicators {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const { lastVolume, avgVolume20 } = volumeStats(candles);
  return {
    price,
    sma200: sma(closes, 200),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    support20: support20(closes),
    resistance20: resistance20(closes),
    change3d: change3d(closes),
    lastVolume,
    avgVolume20,
  };
}
