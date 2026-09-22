// Single source of truth for our pair name (BTCUSDT) -> Kraken's own pair code
// (XBTUSD). Shared by the spot daily fetcher (kraken.ts) and the futures hourly
// fetcher (hourlyCandleCache.ts) so a pair only needs to be mapped here once.
export const KRAKEN_PAIR_CODES: Record<string, string> = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
};

export function krakenPairCode(pair: string): string {
  const code = KRAKEN_PAIR_CODES[pair];
  if (!code) throw new Error(`Par sin mapeo de Kraken: ${pair}`);
  return code;
}
