// Turns OpenStreetMap data (from the Overpass API) into what Shadewalk needs:
// buildings with heights, tree canopies, a walkable street graph and "cool stops".
import { projection } from "./geo.ts";

export interface Building { poly: number[]; h: number }
export interface Tree { x: number; y: number; r: number; h: number }
export type PoiKind = "water" | "bench" | "shelter" | "library" | "toilets";
export interface Poi { x: number; y: number; kind: PoiKind; name?: string }
export interface Edge { a: number; b: number; len: number; way: number; half: number }

export interface Area {
  id: string;
  name: string;
  city: string;
  tz: string;
  origin: [number, number]; // lat, lon of (0, 0)
  bounds: [number, number, number, number]; // south, west, north, east
  buildings: Building[];
  trees: Tree[];
  canopy: number[][]; // woods: polygons that are shaded all day
  nodes: number[]; // walkable graph nodes, flat [x0, y0, x1, y1, ...]
  edges: Edge[];
  ways: { name: string; kind: string }[];
  pois: Poi[];
  start?: [number, number]; // suggested route (lat, lon)
  end?: [number, number];
  stats?: { buildingsWithHeight: number; treesMapped: number };
}

export function overpassQuery(s: number, w: number, n: number, e: number): string {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];
(
  way["building"](${b});
  node["natural"="tree"](${b});
  way["natural"="tree_row"](${b});
  way["natural"="wood"](${b});
  way["landuse"="forest"](${b});
  way["highway"](${b});
  node["amenity"~"^(drinking_water|bench|shelter|library|toilets)$"](${b});
);
out body geom;`;
}

const WALK_HALF_WIDTH: Record<string, number> = {
  footway: 0, path: 0, pedestrian: 0, steps: 0, cycleway: 0, track: 0, corridor: 0,
  service: 3, living_street: 5, residential: 5, unclassified: 5, road: 5,
  tertiary: 7, tertiary_link: 7, secondary: 9, secondary_link: 9, primary: 11, primary_link: 11,
};

const DEFAULT_HEIGHT: Record<string, number> = {
  house: 6, detached: 6, bungalow: 4, garage: 3, garages: 3, shed: 3, carport: 3, roof: 4, kiosk: 3, hut: 3,
  residential: 10, apartments: 14, terrace: 9, commercial: 12, retail: 7, office: 20, hotel: 24, industrial: 9, warehouse: 9,
  church: 15, cathedral: 30, school: 9, university: 14, hospital: 20, parking: 9, stadium: 25, civic: 12, public: 12,
};

/** Building height in metres from OSM tags: explicit height, else floors, else a typical height for its type. */
export function buildingHeight(tags: Record<string, string>): { h: number; known: boolean } {
  const num = (v?: string) => {
    if (!v) return NaN;
    const m = v.replace(",", ".").match(/[\d.]+/);
    if (!m) return NaN;
    const x = parseFloat(m[0]);
    return /ft|'/.test(v) ? x * 0.3048 : x;
  };
  const h = num(tags.height);
  if (h > 0 && h < 600) return { h, known: true };
  const levels = num(tags["building:levels"]);
  if (levels > 0 && levels < 200) return { h: levels * 3.2 + (tags.roof?.length ? 1 : 0.5), known: true };
  return { h: DEFAULT_HEIGHT[tags.building] ?? 8, known: false };
}

/** Tree height and canopy radius. Palms are tall but give very little shade. */
export function treeShape(tags: Record<string, string>): { h: number; r: number } {
  const all = `${tags.genus ?? ""} ${tags.species ?? ""} ${tags.taxon ?? ""} ${tags["species:en"] ?? ""} ${tags.leaf_type ?? ""}`.toLowerCase();
  const palm = /palm|washingtonia|phoenix|arecaceae|syagrus|roystonea|cocos/.test(all);
  const h = parseFloat(tags.height) || (palm ? 12 : 8);
  const crown = parseFloat(tags.diameter_crown);
  const r = crown > 0 && crown < 40 ? crown / 2 : palm ? 1.8 : Math.max(2.5, Math.min(6, h * 0.45));
  return { h, r };
}

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

function walkable(tags: Record<string, string>): number | null {
  const half = WALK_HALF_WIDTH[tags.highway];
  if (half === undefined) return null;
  if (tags.foot === "no" || tags.area === "yes") return null;
  if ((tags.access === "private" || tags.access === "no") && tags.foot !== "yes" && tags.foot !== "designated") return null;
  if (tags.indoor === "yes") return null;
  return half;
}

export function parseOverpass(
  json: { elements: OsmElement[] },
  meta: { id: string; name: string; city: string; tz: string; bounds: [number, number, number, number]; start?: [number, number]; end?: [number, number] },
): Area {
  const [s, w, n, e] = meta.bounds;
  const origin: [number, number] = [(s + n) / 2, (w + e) / 2];
  const proj = projection(origin[0], origin[1]);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const xy = (lat: number, lon: number) => proj.toXY(lat, lon).map(r1) as [number, number];

  const buildings: Building[] = [];
  const trees: Tree[] = [];
  const canopy: number[][] = [];
  const pois: Poi[] = [];
  const ways: { name: string; kind: string }[] = [];
  const nodeIndex = new Map<number, number>();
  const nodes: number[] = [];
  const rawEdges: Edge[] = [];
  let buildingsWithHeight = 0;

  const ring = (g: { lat: number; lon: number }[]) => {
    const out: number[] = [];
    for (const p of g) out.push(...xy(p.lat, p.lon));
    if (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2; // drop closing point
    return out;
  };

  for (const el of json.elements) {
    const tags = el.tags ?? {};
    if (el.type === "node") {
      if (el.lat === undefined || el.lon === undefined) continue;
      const [x, y] = xy(el.lat, el.lon);
      if (tags.natural === "tree") {
        trees.push({ x, y, ...treeShape(tags) });
      } else if (tags.amenity) {
        const kind = ({ drinking_water: "water", bench: "bench", shelter: "shelter", library: "library", toilets: "toilets" } as const)[tags.amenity as "bench"];
        if (kind) pois.push({ x, y, kind, ...(tags.name ? { name: tags.name } : {}) });
      }
      continue;
    }
    if (el.type !== "way" || !el.geometry?.length) continue;
    if (tags.building && tags.building !== "no") {
      const poly = ring(el.geometry);
      if (poly.length >= 6) {
        const { h, known } = buildingHeight(tags);
        if (known) buildingsWithHeight++;
        buildings.push({ poly, h: r1(h) });
      }
    } else if (tags.natural === "wood" || tags.landuse === "forest") {
      const poly = ring(el.geometry);
      if (poly.length >= 6) canopy.push(poly);
    } else if (tags.natural === "tree_row") {
      // A tree every 8 m along the row
      const g = el.geometry.map((p) => proj.toXY(p.lat, p.lon));
      const shape = treeShape(tags);
      for (let i = 1; i < g.length; i++) {
        const [ax, ay] = g[i - 1], [bx, by] = g[i];
        const len = Math.hypot(bx - ax, by - ay);
        for (let d = 0; d < len; d += 8) trees.push({ x: r1(ax + ((bx - ax) * d) / len), y: r1(ay + ((by - ay) * d) / len), ...shape });
      }
    } else if (tags.highway && el.nodes) {
      const half = walkable(tags);
      if (half === null) continue;
      const wayIdx = ways.length;
      ways.push({ name: tags.name ?? "", kind: tags.highway });
      let prev = -1;
      el.nodes.forEach((osmId, i) => {
        const g = el.geometry![i];
        if (!g) return;
        let idx = nodeIndex.get(osmId);
        if (idx === undefined) {
          idx = nodes.length / 2;
          nodeIndex.set(osmId, idx);
          nodes.push(...xy(g.lat, g.lon));
        }
        if (prev >= 0 && prev !== idx) {
          const len = Math.hypot(nodes[idx * 2] - nodes[prev * 2], nodes[idx * 2 + 1] - nodes[prev * 2 + 1]);
          rawEdges.push({ a: prev, b: idx, len: r1(len), way: wayIdx, half });
        }
        prev = idx;
      });
    }
  }

  const { nodes: keptNodes, edges } = largestComponent(nodes, rawEdges);
  return {
    id: meta.id, name: meta.name, city: meta.city, tz: meta.tz, origin, bounds: meta.bounds,
    buildings, trees, canopy, nodes: keptNodes, edges, ways, pois,
    ...(meta.start ? { start: meta.start } : {}), ...(meta.end ? { end: meta.end } : {}),
    stats: { buildingsWithHeight, treesMapped: trees.length },
  };
}

/** Keep only the biggest connected piece of the street network, so routes never start on an island. */
export function largestComponent(nodes: number[], edges: Edge[]): { nodes: number[]; edges: Edge[] } {
  const count = nodes.length / 2;
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (const e of edges) parent[find(e.a)] = find(e.b);
  const size = new Map<number, number>();
  for (let i = 0; i < count; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  let best = -1, bestSize = 0;
  for (const [root, sz] of size) if (sz > bestSize) { best = root; bestSize = sz; }
  const remap = new Int32Array(count).fill(-1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (find(i) === best) { remap[i] = out.length / 2; out.push(nodes[i * 2], nodes[i * 2 + 1]); }
  }
  return {
    nodes: out,
    edges: edges.filter((e) => remap[e.a] >= 0 && remap[e.b] >= 0).map((e) => ({ ...e, a: remap[e.a], b: remap[e.b] })),
  };
}
