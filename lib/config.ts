// All tunables, read from the environment with sensible defaults.

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" ? v : fallback;
};

export type Config = {
  /** Alert when price moves at least this much (fraction, 0.015 = 1.5%) from where it was when the news arrived. */
  movePct: number;
  /** The move must also be at least this fraction of yesterday's high-low range (volatile stocks need bigger moves). */
  rangeFraction: number;
  /** Volume since the headline must be at least this multiple of the stock's normal pace (yesterday's volume per minute). */
  minVolumeRatio: number;
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
  /** News from while the market was closed: minutes after the open that make up the opening range. */
  openRangeMinutes: number;
  /** ...and how long after the open to watch for a break of that range. */
  openWatchMinutes: number;
  /** A break must clear the range high/low by this fraction (0.001 = 0.1%). */
  breakoutBuffer: number;
  /** Don't start intraday watches from reactive headlines (articles written after a stock already moved). */
  skipReactive: boolean;
  /** Safety cap: alerts beyond these are recorded but not emailed or traded. */
  maxAlertsPer5Min: number;
  maxAlertsPerDay: number;
  /** Missed moves: a stock up or down at least this much on the day (fraction) with no alert. */
  missMovePct: number;
  /** Close each paper trade after this many minutes; 0 holds it to the end of the day. Always closed before the close. */
  holdMinutes: number;
  /** Dollars traded on IEX since the headline (at the alert price) an intraday alert needs, so a few hundred shares can't trigger one. */
  minDollarsSinceNews: number;
  /** Stocks with less than this previous-day IEX dollar volume count as thin and need the move to hold for `thinConfirmSeconds`. */
  thinDollarVolume: number;
  thinConfirmSeconds: number;
  /** Entry orders are limit orders this far past the alert price (fraction); whatever doesn't fill at once is cancelled. */
  limitSlippage: number;
  /** Don't trade intraday news on a stock already this far from the previous close when the headline arrived (fraction). */
  maxDayMoveToTrade: number;
  /** No new trades in the last this-many minutes of the session (15 = 3:45 PM); alerts after that are logged only. */
  tradeCutoffMinutes: number;
  /** Minutes before the close to send market-on-close exit orders (Alpaca takes them until about 3:50 PM). */
  mocLeadMinutes: number;
};

export function loadConfig(): Config {
  return {
    movePct: num("MOVE_PCT", 1.5) / 100,
    rangeFraction: num("RANGE_FRACTION", 0.25),
    minVolumeRatio: num("MIN_VOLUME_RATIO", 2),
    confirmTicks: num("CONFIRM_TICKS", 2),
    watchMinutes: num("WATCH_MINUTES", 30),
    pollSeconds: num("POLL_SECONDS", 5),
    maxSymbolsPerHeadline: num("MAX_SYMBOLS_PER_HEADLINE", 4),
    minPrice: num("MIN_PRICE", 3),
    minIexDollarVolume: num("MIN_IEX_DOLLAR_VOLUME", 2_000_000),
    cooldownMinutes: num("COOLDOWN_MINUTES", 120),
    paperTrading: (process.env.PAPER_TRADING ?? "on").toLowerCase() !== "off",
    tradeNotional: num("TRADE_NOTIONAL", 2000),
    openRangeMinutes: num("OPEN_RANGE_MINUTES", 5),
    openWatchMinutes: num("OPEN_WATCH_MINUTES", 60),
    breakoutBuffer: num("BREAKOUT_BUFFER_PCT", 0.1) / 100,
    skipReactive: (process.env.SKIP_REACTIVE ?? "on").toLowerCase() !== "off",
    maxAlertsPer5Min: num("MAX_ALERTS_PER_5_MIN", 3),
    maxAlertsPerDay: num("MAX_ALERTS_PER_DAY", 20),
    missMovePct: num("MISS_MOVE_PCT", 5) / 100,
    holdMinutes: num("HOLD_MINUTES", 0),
    minDollarsSinceNews: num("MIN_DOLLARS_SINCE_NEWS", 50_000),
    thinDollarVolume: num("THIN_DOLLAR_VOLUME", 5_000_000),
    thinConfirmSeconds: num("THIN_CONFIRM_SECONDS", 30),
    limitSlippage: num("LIMIT_SLIPPAGE_PCT", 0.5) / 100,
    maxDayMoveToTrade: num("MAX_DAY_MOVE_TO_TRADE_PCT", 15) / 100,
    tradeCutoffMinutes: num("TRADE_CUTOFF_MINUTES", 15),
    mocLeadMinutes: num("MOC_LEAD_MINUTES", 12),
  };
}
