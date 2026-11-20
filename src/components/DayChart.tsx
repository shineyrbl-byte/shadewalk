import type { ProfilePoint } from "../lib/analysis.ts";
import { formatMinutes } from "../lib/sun.ts";

// Shade on both routes from sunrise to sunset. Click to jump to a time.
export default function DayChart({ profile, now, best, onPick }: { profile: ProfilePoint[]; now: number; best: number | null; onPick: (min: number) => void }) {
  if (profile.length < 2) return null;
  const W = 320, H = 110, L = 30, R = 8, T = 10, B = 22;
  const t0 = profile[0].min, t1 = profile[profile.length - 1].min;
  const x = (m: number) => L + ((m - t0) / (t1 - t0)) * (W - L - R);
  const y = (s: number) => T + (1 - s) * (H - T - B);
  const line = (k: number) => profile.map((p, i) => `${i ? "L" : "M"}${x(p.min).toFixed(1)},${y(p.shade[k]).toFixed(1)}`).join("");
  const area = `${line(0)}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`;
  const hours: number[] = [];
  for (let h = Math.ceil(t0 / 180) * 180; h <= t1; h += 180) hours.push(h);
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    const m = t0 + ((fx - L) / (W - L - R)) * (t1 - t0);
    onPick(Math.max(t0, Math.min(t1, Math.round(m / 5) * 5)));
  };
  const bestP = best !== null ? profile.find((p) => p.min === best) : undefined;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} onClick={click} role="img" aria-label="Share of each route in shade from sunrise to sunset. Click to choose a time.">
        {[0, 0.5, 1].map((s) => (
          <g key={s}>
            <line x1={L} x2={W - R} y1={y(s)} y2={y(s)} className="grid" />
            <text x={L - 4} y={y(s) + 3} textAnchor="end" className="axis">{Math.round(s * 100)}%</text>
          </g>
        ))}
        {hours.map((h) => <text key={h} x={x(h)} y={H - 6} textAnchor="middle" className="axis">{formatMinutes(h).replace(":00", "")}</text>)}
        <path d={area} className="cool-area" />
        <path d={line(1)} className="short-line" />
        <path d={line(0)} className="cool-line" />
        {now >= t0 && now <= t1 && <line x1={x(now)} x2={x(now)} y1={T} y2={H - B} className="now" />}
        {bestP && <circle cx={x(bestP.min)} cy={y(bestP.shade[0])} r="4.5" className="best" />}
      </svg>
      <figcaption>
        <span className="key cool" /> coolest route <span className="key short" /> shortest route · <span className="muted">tap to pick a time</span>
      </figcaption>
    </figure>
  );
}
