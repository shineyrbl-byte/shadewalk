// Proxy for OpenStreetMap's Overpass API. Calling it from the server avoids browser CORS errors
// (Overpass's "busy" responses carry no CORS headers) and lets us retry and fall back to mirrors.
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

export const config = { maxDuration: 60 };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("POST an Overpass query", { status: 405 });
  const query = (await req.text()).slice(0, 2000);
  // Only allow the query Shadewalk builds: a bounding-box download, nothing else
  if (!query.startsWith("[out:json][timeout:90];") || !/^[\s\S]*out body geom;$/.test(query.trim())) {
    return new Response("Unexpected query", { status: 400 });
  }
  const started = Date.now();
  let last = "";
  for (const url of ENDPOINTS) {
    const left = 55_000 - (Date.now() - started);
    if (left < 5_000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(25_000, left));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Shadewalk (https://github.com/shineyrbl-byte/shadewalk)" },
        body: "data=" + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (res.ok) {
        return new Response(await res.text(), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
      }
      last = `${res.status}`;
    } catch (e) {
      last = (e as Error).name === "AbortError" ? "timeout" : "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }
  return new Response(JSON.stringify({ error: `OpenStreetMap servers busy (${last})` }), { status: 503, headers: { "content-type": "application/json" } });
}
