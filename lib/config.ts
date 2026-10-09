// All tunables, read from the environment with sensible defaults.

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" ? v : fallback;
};

export type Config = {
  /** Alert when price moves at least this much (fraction, 0.015 = 1.5%) from where it was when the news arrived. */
  movePct: number;
  /** Consecutive price checks that must agree before alerting (filters one-off prints). */
  confirmTicks: number;
  /** How long to watch a stock after a headline, in minutes. */
  watchMinutes: number;
  /** Seconds between price checks. */
  pollSeconds: number;
  /** Skip headlines tagged with more tickers than this (roundups, "stocks to watch" lists). */
  maxSymbolsPerHeadline: number;
  /** Skip stocks under this price. */
  minPrice: number;
  /** Skip stocks whose previous-day dollar volume on IEX is below this (IEX is ~2–3% of all trading). */
  minIexDollarVolume: number;
  /** Don't alert the same stock again within this many minutes. */
  cooldownMinutes: number;
  /** Paper-trade each alert in the direction of the move. */
  paperTrading: boolean;
  /** Dollars per paper trade. */
  tradeNotional: number;
  /** Close each paper trade after this many minutes; 0 holds it to the end of the day. Always closed before the close. */
  holdMinutes: number;
};

export function loadConfig(): Config {
  return {
    movePct: num("MOVE_PCT", 1.5) / 100,
    confirmTicks: num("CONFIRM_TICKS", 2),
    watchMinutes: num("WATCH_MINUTES", 30),
    pollSeconds: num("POLL_SECONDS", 5),
    maxSymbolsPerHeadline: num("MAX_SYMBOLS_PER_HEADLINE", 4),
    minPrice: num("MIN_PRICE", 3),
    minIexDollarVolume: num("MIN_IEX_DOLLAR_VOLUME", 500_000),
    cooldownMinutes: num("COOLDOWN_MINUTES", 120),
    paperTrading: (process.env.PAPER_TRADING ?? "on").toLowerCase() !== "off",
    tradeNotional: num("TRADE_NOTIONAL", 2000),
    holdMinutes: num("HOLD_MINUTES", 0),
  };
}
