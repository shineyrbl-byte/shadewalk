// Things Shadewalk tells you beyond the route: when to leave, where to cool down on the way,
// and which streets most need trees.
import type { Area, Poi } from "./osm.ts";
import { ShadeModel, edgeSun } from "./shade.ts";
import { sunPosition, zonedTime } from "./sun.ts";

export interface ProfilePoint { min: number; shade: number[] } // shade share per path at that minute

/** Shade on each fixed path across the day, every `step` minutes from `from` to `to`. */
export function dayProfile(model: ShadeModel, area: Area, paths: number[][], date: string, from: number, to: number, step = 15): ProfilePoint[] {
  const all = new Set(paths.flat());
  const out: ProfilePoint[] = [];
  for (let min = from; min <= to; min += step) {
    model.setSun(sunPosition(zonedTime(date, min, area.tz), area.origin[0], area.origin[1]));
    const { sun } = edgeSun(model, area, all);
    out.push({
      min,
      shade: paths.map((p) => {
        let len = 0, lit = 0;
        for (const e of p) { len += area.edges[e].len; lit += area.edges[e].len * sun[e]; }
        return len ? 1 - lit / len : 1;
      }),
    });
  }
  return out;
}

/** The shadiest moment for path `which` within `window` minutes of `around`. */
export function bestTime(profile: ProfilePoint[], which: number, around: number, window = 120): ProfilePoint | null {
  let best: ProfilePoint | null = null;
  for (const p of profile) {
    if (Math.abs(p.min - around) > window) continue;
    if (!best || p.shade[which] > best.shade[which] + 0.005) best = p;
  }
  return best;
}

/** Water, benches, shelters, libraries and toilets within `radius` metres of the route. */
export function stopsNear(area: Area, routeNodes: number[], radius = 35): Poi[] {
  const r2 = radius * radius;
  const n = area.nodes;
  return area.pois.filter((p) => routeNodes.some((i) => (n[i * 2] - p.x) ** 2 + (n[i * 2 + 1] - p.y) ** 2 < r2));
}

export interface SunTrap {
  name: string;
  kind: string;
  length: number; // metres of the street in the area
  sunShare: number; // 0..1 in direct sun
  mid: [number, number]; // local x, y to zoom to
}

/**
 * Streets that are almost entirely in the sun at this moment, longest sunny stretch first.
 * These are where a row of trees or a shade structure would help walkers most.
 */
export function sunTraps(area: Area, sun: Float32Array, limit = 8): SunTrap[] {
  const groups = new Map<string, { kind: string; len: number; lit: number; mx: number; my: number }>();
  const n = area.nodes;
  area.edges.forEach((e, i) => {
    const w = area.ways[e.way];
    if (!w.name || w.kind === "service") return;
    const key = w.name;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { kind: w.kind, len: 0, lit: 0, mx: 0, my: 0 }));
    g.len += e.len;
    g.lit += e.len * sun[i];
    // length-weighted midpoint
    g.mx += ((n[e.a * 2] + n[e.b * 2]) / 2) * e.len;
    g.my += ((n[e.a * 2 + 1] + n[e.b * 2 + 1]) / 2) * e.len;
  });
  return [...groups.entries()]
    .filter(([, g]) => g.len > 80 && g.lit / g.len > 0.75)
    .map(([name, g]) => ({ name, kind: g.kind, length: g.len, sunShare: g.lit / g.len, mid: [g.mx / g.len, g.my / g.len] as [number, number] }))
    .sort((a, b) => b.length * b.sunShare - a.length * a.sunShare)
    .slice(0, limit);
}

/** Share of the whole walking network that's in shade. */
export function networkShade(area: Area, sun: Float32Array): number {
  let len = 0, lit = 0;
  area.edges.forEach((e, i) => { len += e.len; lit += e.len * sun[i]; });
  return len ? 1 - lit / len : 1;
}
