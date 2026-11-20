// Downloads one area from OpenStreetMap (Overpass API) and saves it as public/areas/<id>.json.
// Usage: node scripts/fetch-area.ts <id> "<Name>" "<City>" <time zone> <s,w,n,e> [start lat,lon] [end lat,lon]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { overpassQuery, parseOverpass } from "../src/lib/osm.ts";

const [id, name, city, tz, bbox, start, end] = process.argv.slice(2);
if (!id || !bbox) {
  console.error('Usage: node scripts/fetch-area.ts <id> "<Name>" "<City>" <tz> <s,w,n,e> [start lat,lon] [end lat,lon]');
  process.exit(1);
}
const bounds = bbox.split(",").map(Number) as [number, number, number, number];
const pair = (v?: string) => (v ? (v.split(",").map(Number) as [number, number]) : undefined);

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
let json: { elements: never[] } | null = null;
for (const url of ENDPOINTS) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "shadewalk-area-fetch" },
      body: "data=" + encodeURIComponent(overpassQuery(...bounds)),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    json = await res.json();
    break;
  } catch (e) {
    console.warn(`${url} failed: ${(e as Error).message}`);
  }
}
if (!json) process.exit(1);

const area = parseOverpass(json, { id, name, city, tz, bounds, start: pair(start), end: pair(end) });
mkdirSync("public/areas", { recursive: true });
writeFileSync(`public/areas/${id}.json`, JSON.stringify(area));

const indexPath = "public/areas/index.json";
const index: { id: string; name: string; city: string }[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
const entry = { id, name, city };
const at = index.findIndex((a) => a.id === id);
if (at >= 0) index[at] = entry;
else index.push(entry);
writeFileSync(indexPath, JSON.stringify(index, null, 2));

console.log(`${id}: ${area.buildings.length} buildings (${area.stats!.buildingsWithHeight} with height), ${area.trees.length} trees, ` +
  `${area.nodes.length / 2} nodes, ${area.edges.length} edges, ${area.pois.length} cool stops`);
