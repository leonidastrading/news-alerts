// A rough label for what kind of news a headline is, from keywords. First match wins.
const RULES: [string, RegExp][] = [
  ["Earnings", /\b(earnings|eps|quarterly results|q[1-4] (results|sales|revenue)|reports? (q[1-4]|fiscal|first|second|third|fourth)|beats|misses|tops estimates)\b/i],
  ["Guidance", /\b(guidance|outlook|forecasts?|raises (fy|full-year|annual)|lowers (fy|full-year|annual)|reaffirms)\b/i],
  ["M&A", /\b(acquires?|acquisition|merger|merge|to buy|buyout|takeover|tender offer|to be acquired|deal to (buy|acquire)|spin-?off)\b/i],
  ["FDA / clinical", /\b(fda|clinical|phase (1|2|3|i|ii|iii)|trial|approval|approves|breakthrough therapy|pdufa|ema)\b/i],
  ["Analyst rating", /\b(upgrades?|downgrades?|price target|initiates|initiated|coverage|overweight|underweight|outperform|underperform|reiterates)\b/i],
  ["Offering / financing", /\b(offering|private placement|convertible|notes due|raises \$|priced|registered direct|at-the-market|atm program|dilution)\b/i],
  ["Legal / regulatory", /\b(lawsuit|sues|sued|sec |doj|investigation|probe|ftc|antitrust|settle(s|ment)?|subpoena|fine[sd]?|ruling|court)\b/i],
  ["Contract / partnership", /\b(contract|partnership|partners with|collaboration|agreement|awarded|award|order from|supply deal)\b/i],
  ["Management", /\b(ceo|cfo|coo|chief executive|resigns?|steps down|appoints?|named|board)\b/i],
  ["Buyback / dividend", /\b(buyback|repurchase|dividend|special distribution|stock split)\b/i],
];

export function categorize(headline: string, summary = ""): string {
  for (const [label, re] of RULES) if (re.test(headline)) return label;
  for (const [label, re] of RULES) if (re.test(summary)) return label;
  return "Other";
}
