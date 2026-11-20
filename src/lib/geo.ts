// Small geometry toolkit. Everything works in local metres (x east, y north) around an area's origin.

export type Pt = [number, number];

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

export interface Projection {
  toXY(lat: number, lon: number): Pt;
  toLatLon(x: number, y: number): [number, number];
}

/** Flat-earth projection around an origin. Under 0.1% error across a few kilometres. */
export function projection(lat0: number, lon0: number): Projection {
  const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLatLon: (x, y) => [lat0 + y / M_PER_DEG_LAT, lon0 + x / kx],
  };
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Ray-casting point-in-polygon. The polygon is a flat list [x0, y0, x1, y1, ...]. */
export function pointInPolygon(x: number, y: number, poly: Float64Array | number[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Does the segment A→B touch the polygon (cross an edge, or start inside)? */
export function segmentHitsPolygon(ax: number, ay: number, bx: number, by: number, poly: Float64Array | number[]): boolean {
  if (pointInPolygon(ax, ay, poly) || pointInPolygon(bx, by, poly)) return true;
  const n = poly.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    if (segmentsCross(ax, ay, bx, by, poly[j], poly[j + 1], poly[i], poly[i + 1])) return true;
  }
  return false;
}

/** Convex hull (monotone chain) of a set of points, counter-clockwise. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function bbox(poly: Float64Array | number[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i], y = poly[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
