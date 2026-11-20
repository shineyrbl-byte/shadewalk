// Routing on the walking network: the shortest route, and the coolest one.
// Cost of a segment = length × (1 + heat × share of it in direct sun). With heat = 0 that's the
// plain shortest path; higher heat makes a sunny metre "feel longer" than a shady one.
import type { Area } from "./osm.ts";

export const WALK_SPEED = 1.3; // metres per second (about 4.7 km/h)

export interface Graph {
  start: Int32Array; // CSR offsets per node
  adj: Int32Array; // pairs [edge, neighbour]
}

export function buildGraph(area: Area): Graph {
  const count = area.nodes.length / 2;
  const deg = new Int32Array(count + 1);
  for (const e of area.edges) { deg[e.a + 1]++; deg[e.b + 1]++; }
  for (let i = 0; i < count; i++) deg[i + 1] += deg[i];
  const fill = deg.slice();
  const adj = new Int32Array(area.edges.length * 4);
  area.edges.forEach((e, i) => {
    adj[fill[e.a] * 2] = i; adj[fill[e.a] * 2 + 1] = e.b; fill[e.a]++;
    adj[fill[e.b] * 2] = i; adj[fill[e.b] * 2 + 1] = e.a; fill[e.b]++;
  });
  return { start: deg, adj };
}

export function nearestNode(area: Area, x: number, y: number): number {
  let best = 0, bestD = Infinity;
  const n = area.nodes;
  for (let i = 0; i < n.length; i += 2) {
    const d = (n[i] - x) ** 2 + (n[i + 1] - y) ** 2;
    if (d < bestD) { bestD = d; best = i / 2; }
  }
  return best;
}

/** A* search. Returns the list of edges from src to dst, or null if unreachable. */
export function findRoute(area: Area, g: Graph, src: number, dst: number, cost: (edge: number) => number): number[] | null {
  const count = area.nodes.length / 2;
  const n = area.nodes;
  const best = new Float64Array(count).fill(Infinity);
  const via = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  const tx = n[dst * 2], ty = n[dst * 2 + 1];
  const h = (i: number) => Math.hypot(n[i * 2] - tx, n[i * 2 + 1] - ty); // admissible: cost ≥ length
  // Binary min-heap of nodes keyed by f = cost so far + straight-line distance left
  const hf: number[] = [], hn: number[] = [];
  const swap = (i: number, j: number) => {
    [hf[i], hf[j]] = [hf[j], hf[i]];
    [hn[i], hn[j]] = [hn[j], hn[i]];
  };
  const push = (f: number, node: number) => {
    hf.push(f); hn.push(node);
    let i = hf.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= hf[i]) break;
      swap(p, i);
      i = p;
    }
  };
  const pop = (): number => {
    const top = hn[0];
    const lastF = hf.pop()!, lastN = hn.pop()!;
    if (hf.length) {
      hf[0] = lastF; hn[0] = lastN;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < hf.length && hf[l] < hf[m]) m = l;
        if (r < hf.length && hf[r] < hf[m]) m = r;
        if (m === i) break;
        swap(m, i);
        i = m;
      }
    }
    return top;
  };
  best[src] = 0;
  push(h(src), src);
  while (hf.length) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === dst) break;
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const edge = g.adj[k * 2], v = g.adj[k * 2 + 1];
      if (done[v]) continue;
      const c = best[u] + cost(edge);
      if (c < best[v]) { best[v] = c; via[v] = edge; push(c + h(v), v); }
    }
  }
  if (src !== dst && via[dst] < 0) return null;
  const path: number[] = [];
  let cur = dst;
  while (cur !== src) {
    const e = via[cur];
    path.push(e);
    const edge = area.edges[e];
    cur = edge.a === cur ? edge.b : edge.a;
  }
  return path.reverse();
}

export interface RouteStats {
  length: number; // metres
  sunMeters: number;
  shade: number; // 0..1 share of the route in shade
  minutes: number;
  sunMinutes: number;
}

export function routeStats(area: Area, path: number[], sun: Float32Array, speed = WALK_SPEED): RouteStats {
  let length = 0, sunMeters = 0;
  for (const e of path) { length += area.edges[e].len; sunMeters += area.edges[e].len * sun[e]; }
  const minutes = length / speed / 60;
  return { length, sunMeters, shade: length ? 1 - sunMeters / length : 1, minutes, sunMinutes: sunMeters / speed / 60 };
}

/** True for stairs, so step-free routing can skip them. */
export const isSteps = (area: Area, edge: number) => area.ways[area.edges[edge].way].kind === "steps";

/** The node ids along a path, in walking order. */
export function pathNodes(area: Area, path: number[], src: number): number[] {
  const out = [src];
  let cur = src;
  for (const e of path) {
    const edge = area.edges[e];
    cur = edge.a === cur ? edge.b : edge.a;
    out.push(cur);
  }
  return out;
}
