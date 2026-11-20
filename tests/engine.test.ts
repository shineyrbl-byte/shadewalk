import { test } from "node:test";
import assert from "node:assert/strict";
import { sunPosition, zonedTime, tzOffsetMinutes } from "../src/lib/sun.ts";
import { pointInPolygon, segmentHitsPolygon, convexHull } from "../src/lib/geo.ts";
import { buildingHeight, treeShape, largestComponent, type Area } from "../src/lib/osm.ts";
import { ShadeModel, edgeSun } from "../src/lib/shade.ts";
import { buildGraph, findRoute, routeStats } from "../src/lib/route.ts";

const blank = (over: Partial<Area> = {}): Area => ({
  id: "t", name: "t", city: "t", tz: "UTC", origin: [0, 0], bounds: [0, 0, 0, 0],
  buildings: [], trees: [], canopy: [], nodes: [], edges: [], ways: [], pois: [], ...over,
});

test("sun: Phoenix solstice noon is ~80° high in the south; 9am is in the east", () => {
  const noon = sunPosition(zonedTime("2026-06-21", 12 * 60 + 28, "America/Phoenix"), 33.45, -112.07);
  assert.ok(Math.abs(noon.altitude - 80) < 0.5, `alt ${noon.altitude}`);
  assert.ok(Math.abs(noon.azimuth - 180) < 5, `az ${noon.azimuth}`);
  const morning = sunPosition(zonedTime("2026-06-21", 9 * 60, "America/Phoenix"), 33.45, -112.07);
  assert.ok(morning.azimuth > 70 && morning.azimuth < 110);
  const night = sunPosition(zonedTime("2026-06-21", 23 * 60, "America/Phoenix"), 33.45, -112.07);
  assert.ok(night.altitude < 0);
});

test("time zones: Phoenix has no DST, Madrid does", () => {
  assert.equal(tzOffsetMinutes(Date.UTC(2026, 6, 1), "America/Phoenix"), -420);
  assert.equal(tzOffsetMinutes(Date.UTC(2026, 0, 1), "America/Phoenix"), -420);
  assert.equal(tzOffsetMinutes(Date.UTC(2026, 6, 1), "Europe/Madrid"), 120);
  assert.equal(tzOffsetMinutes(Date.UTC(2026, 0, 1), "Europe/Madrid"), 60);
  assert.equal(new Date(zonedTime("2026-07-01", 9 * 60, "Europe/Madrid")).toISOString(), "2026-07-01T07:00:00.000Z");
});

test("geometry basics", () => {
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.ok(pointInPolygon(5, 5, sq));
  assert.ok(!pointInPolygon(15, 5, sq));
  assert.ok(segmentHitsPolygon(-5, 5, 15, 5, sq)); // passes straight through
  assert.ok(!segmentHitsPolygon(-5, 15, 15, 15, sq));
  assert.equal(convexHull([[0, 0], [1, 1], [2, 0], [1, 0.2], [1, -1]]).length, 4);
});

test("OSM tags: heights from height, floors or building type; palms give little shade", () => {
  assert.equal(buildingHeight({ building: "yes", height: "24 m" }).h, 24);
  assert.ok(Math.abs(buildingHeight({ building: "yes", height: "40'" }).h - 12.19) < 0.01);
  assert.equal(buildingHeight({ building: "yes", "building:levels": "5" }).h, 16.5);
  assert.deepEqual(buildingHeight({ building: "house" }), { h: 6, known: false });
  assert.ok(treeShape({ genus: "Washingtonia" }).r < 2);
  assert.ok(treeShape({ species: "Quercus virginiana" }).r >= 2.5);
  assert.equal(treeShape({ diameter_crown: "10" }).r, 5);
});

test("street network keeps only the largest connected piece", () => {
  const nodes = [0, 0, 1, 0, 2, 0, 50, 50, 51, 50];
  const edges = [
    { a: 0, b: 1, len: 1, way: 0, half: 0 },
    { a: 1, b: 2, len: 1, way: 0, half: 0 },
    { a: 3, b: 4, len: 1, way: 1, half: 0 },
  ];
  const r = largestComponent(nodes, edges);
  assert.equal(r.nodes.length / 2, 3);
  assert.equal(r.edges.length, 2);
});

test("a 10 m building casts a 10 m shadow away from a 45° sun", () => {
  const area = blank({ buildings: [{ poly: [0, 0, 10, 0, 10, 10, 0, 10], h: 10 }] });
  const m = new ShadeModel(area);
  m.setSun({ altitude: 45, azimuth: 180 }); // sun due south → shadow to the north
  assert.ok(m.isShaded(5, 15), "just north of the building");
  assert.ok(m.isShaded(5, 19));
  assert.ok(!m.isShaded(5, 21), "beyond the shadow");
  assert.ok(!m.isShaded(5, -5), "sunny south side");
  assert.ok(!m.isShaded(15, 15), "off to the side");
  m.setSun({ altitude: 45, azimuth: 90 }); // morning sun from the east → shadow to the west
  assert.ok(m.isShaded(-5, 5));
  assert.ok(!m.isShaded(15, 5));
  m.setSun({ altitude: -5, azimuth: 90 });
  assert.ok(m.isShaded(100, 100), "night counts as shade");
  const shadows = new ShadeModel(area);
  shadows.setSun({ altitude: 45, azimuth: 180 });
  assert.equal(shadows.shadowPolygons().buildings.length, 1);
});

test("a tree shades the ground beside it, offset away from the sun", () => {
  const area = blank({ trees: [{ x: 0, y: 0, r: 3, h: 8 }] });
  const m = new ShadeModel(area);
  m.setSun({ altitude: 45, azimuth: 180 }); // canopy 2.8–8 m up → shadow 2.8–8 m to the north
  assert.ok(m.isShaded(0, 5));
  assert.ok(!m.isShaded(0, -4));
  assert.ok(!m.isShaded(0, 14));
  m.setSun({ altitude: 89, azimuth: 180 });
  assert.ok(m.isShaded(1, 0), "midday: right under the canopy");
});

test("the coolest route detours through shade, the shortest doesn't", () => {
  // A square: straight sunny edge 0→1 (100 m) vs a shaded detour 0→2→3→1 (140 m)
  const area = blank({
    nodes: [0, 0, 100, 0, 0, 20, 100, 20],
    edges: [
      { a: 0, b: 1, len: 100, way: 0, half: 0 },
      { a: 0, b: 2, len: 20, way: 1, half: 0 },
      { a: 2, b: 3, len: 100, way: 1, half: 0 },
      { a: 3, b: 1, len: 20, way: 1, half: 0 },
    ],
    // a long, tall wall just south of the detour shades it at a 45° southern sun
    buildings: [{ poly: [-10, 10, 110, 10, 110, 14, -10, 14], h: 12 }],
  });
  const m = new ShadeModel(area);
  m.setSun({ altitude: 45, azimuth: 180 });
  const { sun } = edgeSun(m, area);
  assert.ok(sun[0] > 0.9, "straight edge is sunny");
  assert.ok(sun[2] < 0.1, "detour is shaded");
  const g = buildGraph(area);
  const shortest = findRoute(area, g, 0, 1, (e) => area.edges[e].len)!;
  const coolest = findRoute(area, g, 0, 1, (e) => area.edges[e].len * (1 + 3 * sun[e]))!;
  assert.deepEqual(shortest, [0]);
  assert.deepEqual(coolest, [1, 2, 3]);
  const s = routeStats(area, coolest, sun);
  assert.equal(s.length, 140);
  assert.ok(s.shade > 0.6);
});

import { bestTime, stopsNear, sunTraps, networkShade, dayProfile } from "../src/lib/analysis.ts";

test("analysis: sun traps, nearby stops, best time, network shade", () => {
  const area = blank({
    nodes: [0, 0, 200, 0, 0, 50, 200, 50],
    edges: [
      { a: 0, b: 1, len: 200, way: 0, half: 0 },
      { a: 2, b: 3, len: 200, way: 1, half: 0 },
    ],
    ways: [{ name: "Hot Street", kind: "residential" }, { name: "Leafy Lane", kind: "residential" }],
    pois: [{ x: 10, y: 5, kind: "water" }, { x: 100, y: 25, kind: "bench" }],
  });
  const sun = Float32Array.from([1, 0.1]);
  const traps = sunTraps(area, sun);
  assert.deepEqual(traps.map((t) => t.name), ["Hot Street"]);
  assert.equal(traps[0].mid[0], 100);
  assert.ok(Math.abs(networkShade(area, sun) - 0.45) < 1e-6);
  assert.deepEqual(stopsNear(area, [0, 1]).map((p) => p.kind), ["water"]);
  const profile = [{ min: 600, shade: [0.2] }, { min: 660, shade: [0.5] }, { min: 900, shade: [0.9] }];
  assert.equal(bestTime(profile, 0, 620)!.min, 660); // 900 is outside the 2-hour window
  assert.equal(bestTime(profile, 0, 620, 400)!.min, 900);
});

test("day profile: a wall's shade moves with the sun", () => {
  // A wall south of an east-west street: the street is shaded around noon when the sun is
  // in the south; with the low early sun in the east-northeast it's in the sun.
  const area = blank({
    origin: [33.45, -112.07], tz: "America/Phoenix",
    nodes: [0, 0, 100, 0],
    edges: [{ a: 0, b: 1, len: 100, way: 0, half: 0 }],
    buildings: [{ poly: [-20, -12, 120, -12, 120, -4, -20, -4], h: 40 }],
  });
  const m = new ShadeModel(area);
  const prof = dayProfile(m, area, [[0]], "2026-12-21", 9 * 60, 15 * 60, 60);
  const noon = prof.find((p) => p.min === 12 * 60)!;
  assert.ok(noon.shade[0] > 0.9, `winter noon shade ${noon.shade[0]}`);
});
