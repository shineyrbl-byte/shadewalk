// Turn-by-turn directions for a route, with which sidewalk is shadier.
import type { Area } from "./osm.ts";

export interface Step {
  text: string; // "Turn left onto North 2nd Street"
  street: string;
  metres: number;
  sunShare: number; // 0..1
  side: string | null; // "east side" when one sidewalk is shadier
  covered: boolean;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const compass = (dx: number, dy: number) => COMPASS[Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 / 45) % 8];

const KIND_NAME: Record<string, string> = {
  footway: "the footpath", path: "the path", pedestrian: "the pedestrian street", steps: "the steps", cycleway: "the cycle path",
  service: "the service road", living_street: "the street", residential: "the street", corridor: "the passage", track: "the track",
};

/**
 * Groups the route's segments into steps along the same street, with the turn between them.
 * `side` per edge: -1 / 1 = the shadier sidewalk is to the right / left of the edge drawn a→b.
 */
export function directions(area: Area, edges: number[], nodes: number[], sun: Float32Array, side: Int8Array): Step[] {
  const n = area.nodes;
  type Seg = { street: string; len: number; lit: number; dx: number; dy: number; sideVotes: Map<string, number>; covered: number };
  const segs: Seg[] = [];
  edges.forEach((ei, k) => {
    const e = area.edges[ei];
    const from = nodes[k], to = nodes[k + 1];
    const dx = n[to * 2] - n[from * 2], dy = n[to * 2 + 1] - n[from * 2 + 1];
    const way = area.ways[e.way];
    const street = way.name || KIND_NAME[way.kind] || "the street";
    // Which compass side is the shadier sidewalk on, in the direction we're walking?
    let sideName: string | null = null;
    if (side[ei] !== 0 && e.len > 0) {
      const forward = from === e.a;
      const s = side[ei] * (forward ? 1 : -1); // relative to our walking direction: -1 right, 1 left
      // left of (dx, dy) is (-dy, dx); right is (dy, -dx)
      sideName = s > 0 ? compass(-dy, dx) : compass(dy, -dx);
    }
    const last = segs[segs.length - 1];
    if (last && last.street === street) {
      last.len += e.len; last.lit += e.len * sun[ei]; last.dx += dx; last.dy += dy;
      if (sideName) last.sideVotes.set(sideName, (last.sideVotes.get(sideName) ?? 0) + e.len);
      if (e.cov) last.covered += e.len;
    } else {
      segs.push({ street, len: e.len, lit: e.len * sun[ei], dx, dy, sideVotes: new Map(sideName ? [[sideName, e.len]] : []), covered: e.cov ? e.len : 0 });
    }
  });

  // Merge tiny wiggles (crossings, short connectors) into the step before them, then join
  // neighbouring steps that turned out to be on the same street
  const absorb = (into: Seg, s: Seg) => {
    into.len += s.len; into.lit += s.lit; into.covered += s.covered;
    for (const [k, v] of s.sideVotes) into.sideVotes.set(k, (into.sideVotes.get(k) ?? 0) + v);
  };
  const merged: Seg[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && (s.len < 12 || s.street === prev.street)) {
      absorb(prev, s);
      if (s.street === prev.street) { prev.dx += s.dx; prev.dy += s.dy; }
      continue;
    }
    merged.push(s);
  }

  return merged.map((s, i) => {
    let text: string;
    const onto = s.street;
    if (i === 0) text = `Head ${compass(s.dx, s.dy)} on ${onto}`;
    else {
      const p = merged[i - 1];
      const a1 = Math.atan2(p.dx, p.dy), a2 = Math.atan2(s.dx, s.dy);
      let turn = ((a2 - a1) * 180) / Math.PI;
      turn = ((turn + 540) % 360) - 180; // -180..180, positive = clockwise = right
      const word = Math.abs(turn) < 30 ? "Continue onto" : turn > 0 ? (turn > 120 ? "Turn sharp right onto" : "Turn right onto") : turn < -120 ? "Turn sharp left onto" : "Turn left onto";
      text = `${word} ${onto}`;
    }
    let side: string | null = null, best = 0;
    for (const [name, len] of s.sideVotes) if (len > best) { best = len; side = `${name} side`; }
    return { text, street: s.street, metres: s.len, sunShare: s.len ? s.lit / s.len : 0, side, covered: s.covered > s.len / 2 };
  });
}

export const PACES = [
  { id: "normal", label: "Normal", speed: 1.3 },
  { id: "relaxed", label: "Relaxed", speed: 1.0 },
  { id: "slow", label: "With kids / slower", speed: 0.8 },
] as const;
