// Where a Benzinga headline comes from, judged from its wording and author. This matters because
// some kinds can arrive before a move (press releases, filings, earnings numbers) and some can only
// arrive after it (articles written because a stock is already moving). First match wins.

export const ORIGINS = [
  "Reactive (after the move)",
  "Citing another outlet",
  "SEC filing",
  "Press release",
  "Earnings numbers",
  "Analyst action",
  "Other",
] as const;
export type Origin = (typeof ORIGINS)[number];

const REACTIVE =
  /\b(why (is|are|did) .{1,60}(stock|shares)|what'?s going on with|here'?s why|shares? (are|is) (trading|moving|falling|rising|sliding|soaring|jumping|plunging|spiking|surging|sinking|dropping|rallying|higher|lower|down|up)|(stocks?|shares?) (soars?|jumps?|plunges?|tumbles?|slides?|surges?|falls?|rises?|sinks?|drops?|spikes?|rall(y|ies)|craters?|rockets?|skyrockets?|pops?|dips?|gaps? (up|down))\b|trading (higher|lower)|on the move|hits? (a |new |fresh )*(52-week|all-time|record|multi-year|\d+-year) (high|low)|(soars?|jumps?|surges?|plunges?|tumbles?|sinks?|slides?|rall(y|ies)|spikes?|craters?|falls?|rises?|drops?|climbs?|gains?|loses?) \d+(\.\d+)?%|(premarket|pre-market|after-hours|midday|mid-day) (movers|session|trading)|movers|stocks moving|biggest (gainers|losers|movers)|top (gainers|losers))/i;
const CITING =
  /\b(according to|citing|reportedly|report says|reports say|sources say|people familiar|(bloomberg|reuters|wsj|wall street journal|cnbc|financial times|ft|the information|axios|barron'?s|dow jones|nyt|new york times|semafor|politico) (reports?|says|reported)|per (a )?(bloomberg|reuters|wsj|cnbc|ft|report))\b/i;
const FILING =
  /\b(form 4|8-k|10-q|10-k|13d|13g|13f|s-1|f-1|s-3|424b|prospectus|sec filing|in a filing|filing shows|files? (for|with the sec)|insider (buy|buys|bought|sell|sells|sold|purchase|sale))\b/i;
const WIRE = /\b(newswire|business ?wire|globe ?newswire|accesswire|pr ?newswire|newsfile|press release|marketwired|cision)\b/i;
const PRESS_PHRASING =
  /^[^:]{2,80}\b(announces?|to present|to participate|launches?|introduces|declares|completes|enters into|appoints|receives|signs|unveils|partners with|selected|awarded|expands|closes|prices|files)\b/i;
const EARNINGS = /\b(eps|q[1-4] (eps|revenue|sales|results|earnings)|(beats|misses|tops|exceeds) (estimates?|consensus|expectations)|vs\.? (est|estimate|consensus)|revenue of \$|reports? (q[1-4]|fiscal|first|second|third|fourth)[- ](quarter )?(results|earnings))\b/i;
const ANALYST = /\b(upgrades?|downgrades?|price target|initiates|initiated|maintains|reiterates|overweight|underweight|outperform|underperform|equal-weight|neutral rating|buy rating|sell rating)\b/i;

export function classifyOrigin(n: { headline: string; summary?: string; author?: string; source?: string }): Origin {
  const h = n.headline;
  if (REACTIVE.test(h)) return "Reactive (after the move)";
  if (CITING.test(h)) return "Citing another outlet";
  if (FILING.test(h)) return "SEC filing";
  if (WIRE.test(`${n.author ?? ""} ${n.source ?? ""}`)) return "Press release";
  if (EARNINGS.test(h)) return "Earnings numbers";
  if (ANALYST.test(h)) return "Analyst action";
  if (PRESS_PHRASING.test(h)) return "Press release";
  if (n.summary && CITING.test(n.summary)) return "Citing another outlet";
  return "Other";
}
