"use client";
// Running total of closed paper trades, one step per trade in the order they closed. Hover (or tap)
// shows the trade at that point and the total after it.
import { useEffect, useRef, useState } from "react";

export type EquityPoint = { at: string; symbol: string; pnl: number; total: number };

const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

const money = (x: number) => `${x < 0 ? "−" : x > 0 ? "+" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const money2 = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/** A few round dollar values spanning [lo, hi] for the y-axis. */
function ticks(lo: number, hi: number): number[] {
  const span = hi - lo || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

export function EquityCurve({ points }: { points: EquityPoint[] }) {
  const svg = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width, so labels stay 12px on a phone instead of shrinking.
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 600 ? 200 : 240;
  if (points.length < 2) return null;

  const totals = [0, ...points.map((p) => p.total)];
  const yTicks = ticks(Math.min(0, ...totals), Math.max(0, ...totals));
  const lo = Math.min(yTicks[0], ...totals);
  const hi = Math.max(yTicks.at(-1)!, ...totals);
  const x = (i: number) => PAD.left + (i / points.length) * (W - PAD.left - PAD.right); // i = 0 is the $0 start
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo || 1)) * (H - PAD.top - PAD.bottom);
  const path = totals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  // Date labels at the first trade of each day, thinned to about six (three on a phone).
  const firsts = points.map((p, i) => ({ i: i + 1, d: day(p.at) })).filter((p, k, all) => k === 0 || all[k - 1].d !== p.d);
  const every = Math.ceil(firsts.length / (W < 600 ? 3 : 6));
  const xTicks = firsts.filter((_, k) => k % every === 0);

  const last = points.at(-1)!;
  const move = (clientX: number) => {
    const r = svg.current!.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    const i = Math.round(((sx - PAD.left) / (W - PAD.left - PAD.right)) * points.length);
    setHover(Math.min(points.length, Math.max(1, i)));
  };
  const h = hover != null ? points[hover - 1] : null;

  return (
    <section className="equity">
      <div className="equity-head">
        <h2>Equity curve</h2>
        <span className="equity-total">
          {money2(last.total)}
          <span className="meta-inline"> after {points.length} closed paper trades</span>
        </span>
      </div>
      <div className="equity-chart" ref={box}>
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Cumulative paper P&L over ${points.length} closed trades, now ${money2(last.total)}`}
          onMouseMove={(e) => move(e.clientX)}
          onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => move(e.touches[0].clientX)}
          onTouchMove={(e) => move(e.touches[0].clientX)}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? "zero" : "grid"} />
              <text x={PAD.left - 8} y={y(v)} className="axis" textAnchor="end" dominantBaseline="middle">
                {money(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t.i} x={x(t.i)} y={H - 8} className="axis" textAnchor="middle">
              {t.d}
            </text>
          ))}
          <path d={path} className="line" />
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} className="cross" />
              <circle cx={x(hover)} cy={y(totals[hover])} r={5} className="dot" />
            </g>
          )}
          {/* Hit area over the whole plot, bigger than the line. */}
          <rect x={PAD.left} y={0} width={W - PAD.left - PAD.right} height={H} fill="transparent" />
        </svg>
        {h && (
          <div className="equity-tip" style={{ left: `${Math.min(85, Math.max(15, (x(hover!) / W) * 100))}%` }}>
            <strong>{money2(h.total)} total</strong>
            <span>
              Trade {hover}: {h.symbol} {money2(h.pnl)}
            </span>
            <span>{day(h.at)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
