// The shadow engine. Is this spot in the shade right now?
//
// A point is shaded by a building if, looking from the point towards the sun, the line of sight
// passes through the building below its roof. At sun altitude α, a building of height h can only
// block the sun within h / tan(α) metres of the point, so we test the segment from the point
// towards the sun of that length against the building's footprint. Trees are canopies (a disc
// of radius r between 35% and 100% of the tree's height) tested the same way.
import { bbox, convexHull, pointInPolygon, segmentHitsPolygon, type Pt } from "./geo.ts";
import type { Area } from "./osm.ts";
import type { SunPosition } from "./sun.ts";

const CELL = 20; // metres per grid cell for the spatial index
const MAX_REACH = 400; // never look further than this for a shadow-caster
const TRUNK = 0.35; // canopy starts at 35% of tree height

export class ShadeModel {
  private polys: Float64Array[];
  private boxes: Float64Array; // x0, y0, x1, y1 per building
  private heights: Float64Array;
  private canopyBoxes: [number, number, number, number][];
  private grid = new Map<number, { b: number[]; t: number[] }>();
  private stamp: Uint32Array;
  private treeStamp: Uint32Array;
  private tick = 0;
  private maxH = 0;
  private maxTreeH = 0;
  // current sun
  dx = 0;
  dy = 0;
  tanAlt = 0;
  up = false;

  private area: Area;

  constructor(area: Area) {
    this.area = area;
    const n = area.buildings.length;
    this.polys = area.buildings.map((b) => Float64Array.from(b.poly));
    this.boxes = new Float64Array(n * 4);
    this.heights = new Float64Array(n);
    this.stamp = new Uint32Array(n);
    this.treeStamp = new Uint32Array(area.trees.length);
    area.buildings.forEach((b, i) => {
      const [x0, y0, x1, y1] = bbox(this.polys[i]);
      this.boxes.set([x0, y0, x1, y1], i * 4);
      this.heights[i] = b.h;
      this.maxH = Math.max(this.maxH, b.h);
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) this.cell(cx, cy).b.push(i);
    });
    area.trees.forEach((t, i) => {
      this.maxTreeH = Math.max(this.maxTreeH, t.h);
      for (let cx = Math.floor((t.x - t.r) / CELL); cx <= Math.floor((t.x + t.r) / CELL); cx++)
        for (let cy = Math.floor((t.y - t.r) / CELL); cy <= Math.floor((t.y + t.r) / CELL); cy++) this.cell(cx, cy).t.push(i);
    });
    this.canopyBoxes = area.canopy.map((p) => bbox(p));
  }

  private cell(cx: number, cy: number) {
    const k = cx * 100_003 + cy;
    let c = this.grid.get(k);
    if (!c) this.grid.set(k, (c = { b: [], t: [] }));
    return c;
  }

  setSun(sun: SunPosition) {
    this.up = sun.altitude > 0.5;
    const az = (sun.azimuth * Math.PI) / 180;
    this.dx = Math.sin(az); // unit vector pointing towards the sun, on the ground
    this.dy = Math.cos(az);
    this.tanAlt = Math.tan((Math.max(sun.altitude, 0.5) * Math.PI) / 180);
  }

  /** True if the point is out of direct sunlight (always true at night). */
  isShaded(px: number, py: number): boolean {
    if (!this.up) return true;
    for (let i = 0; i < this.area.canopy.length; i++) {
      const [x0, y0, x1, y1] = this.canopyBoxes[i];
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1 && pointInPolygon(px, py, this.area.canopy[i])) return true;
    }
    const { dx, dy, tanAlt } = this;
    const reach = Math.min(MAX_REACH, Math.max(this.maxH, this.maxTreeH) / tanAlt);
    const tick = ++this.tick;
    const trees = this.area.trees;
    let lastCell = NaN;
    // Walk the grid cells along the line towards the sun (plus neighbours, so nothing slips between)
    for (let d = 0; d <= reach + CELL; d += CELL / 2) {
      const cx = Math.floor((px + dx * d) / CELL), cy = Math.floor((py + dy * d) / CELL);
      const key = cx * 100_003 + cy;
      if (key === lastCell) continue;
      lastCell = key;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const c = this.grid.get((cx + ox) * 100_003 + (cy + oy));
        if (!c) continue;
        for (const i of c.b) {
          if (this.stamp[i] === tick) continue;
          this.stamp[i] = tick;
          const len = Math.min(MAX_REACH, this.heights[i] / tanAlt);
          const ex = px + dx * len, ey = py + dy * len;
          const o = i * 4;
          // quick reject: segment bounding box vs building bounding box
          if (Math.max(px, ex) < this.boxes[o] || Math.min(px, ex) > this.boxes[o + 2] || Math.max(py, ey) < this.boxes[o + 1] || Math.min(py, ey) > this.boxes[o + 3]) continue;
          if (segmentHitsPolygon(px, py, ex, ey, this.polys[i])) return true;
        }
        for (const i of c.t) {
          if (this.treeStamp[i] === tick) continue;
          this.treeStamp[i] = tick;
          const t = trees[i];
          const along = (t.x - px) * dx + (t.y - py) * dy;
          const lo = (t.h * TRUNK) / tanAlt, hi = t.h / tanAlt;
          const dc = along < lo ? lo : along > hi ? hi : along;
          const qx = px + dx * dc - t.x, qy = py + dy * dc - t.y;
          if (qx * qx + qy * qy < t.r * t.r) return true;
        }
      }
    }
    return false;
  }

  /** Shadow shapes to draw on the map: buildings, then trees. Empty at night. */
  shadowPolygons(): { buildings: Pt[][]; trees: Pt[][] } {
    if (!this.up) return { buildings: [], trees: [] };
    const sx = -this.dx, sy = -this.dy; // shadows fall away from the sun
    const buildings = this.area.buildings.map((b, i) => {
      const len = Math.min(MAX_REACH, b.h / this.tanAlt);
      const poly = this.polys[i];
      const pts: Pt[] = [];
      for (let k = 0; k < poly.length; k += 2) {
        pts.push([poly[k], poly[k + 1]], [poly[k] + sx * len, poly[k + 1] + sy * len]);
      }
      return convexHull(pts);
    });
    const trees = this.area.trees.map((t) => {
      const lo = (t.h * TRUNK) / this.tanAlt, hi = Math.min(MAX_REACH, t.h / this.tanAlt);
      const pts: Pt[] = [];
      for (let a = 0; a < 12; a++) {
        const ca = Math.cos((a / 12) * Math.PI * 2) * t.r, sa = Math.sin((a / 12) * Math.PI * 2) * t.r;
        pts.push([t.x + sx * lo + ca, t.y + sy * lo + sa], [t.x + sx * hi + ca, t.y + sy * hi + sa]);
      }
      return convexHull(pts);
    });
    return { buildings, trees };
  }
}

const SAMPLE_STEP = 5; // metres between shade samples along a street

/** How sunny each street segment is (0 = all shade, 1 = all sun), and which side of the road is shadier. */
export function edgeSun(model: ShadeModel, area: Area, which?: Iterable<number>): { sun: Float32Array; side: Int8Array } {
  const sun = new Float32Array(area.edges.length);
  const side = new Int8Array(area.edges.length);
  if (!model.up) return { sun, side };
  const n = area.nodes;
  const list = which ?? area.edges.keys();
  for (const i of list) {
    const e = area.edges[i];
    const ax = n[e.a * 2], ay = n[e.a * 2 + 1], bx = n[e.b * 2], by = n[e.b * 2 + 1];
    const steps = Math.max(1, Math.round(e.len / SAMPLE_STEP));
    // Roads: try both sidewalks (offset by the road's half width) and walk on the shadier one
    const offsets = e.half > 0 ? [-e.half, e.half] : [0];
    const nx = e.len > 0 ? -(by - ay) / e.len : 0, ny = e.len > 0 ? (bx - ax) / e.len : 0;
    let best = 1, bestSide = 0;
    for (let s = 0; s < offsets.length; s++) {
      const off = offsets[s];
      let lit = 0;
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const x = ax + (bx - ax) * t + nx * off, y = ay + (by - ay) * t + ny * off;
        if (!model.isShaded(x, y)) lit++;
      }
      const f = lit / steps;
      if (f < best) { best = f; bestSide = offsets.length === 1 ? 0 : s === 0 ? -1 : 1; }
    }
    sun[i] = best;
    side[i] = bestSide;
  }
  return { sun, side };
}
