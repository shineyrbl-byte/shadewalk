// Proxy for OpenStreetMap's Overpass API. Calling it from the server avoids browser CORS errors
// (Overpass's "busy" responses carry no CORS headers) and lets us retry and fall back to mirrors.
// The main server answers most queries but can take 30-40 s for a neighbourhood, so it gets most
// of the time budget. It also rejects generic user agents (406), which is why browsers can't call it
// directly and this proxy sends a descriptive one.
const ENDPOINTS: [string, number][] = [
  ["https://overpass-api.de/api/interpreter", 48_000],
  ["https://overpass.private.coffee/api/interpreter", 20_000],
  ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", 15_000],
];

export async function GET(): Promise<Response> {
  return new Response("POST an Overpass query", { status: 405 });
}

export async function POST(req: Request): Promise<Response> {
  const query = (await req.text()).slice(0, 2000);
  // Only allow the query Shadewalk builds: a bounding-box download, nothing else
  if (!query.startsWith("[out:json][timeout:90];") || !/^[\s\S]*out body geom;$/.test(query.trim())) {
    return new Response("Unexpected query", { status: 400 });
  }
  const started = Date.now();
  let last = "";
  for (const [url, budget] of ENDPOINTS) {
    const left = 57_000 - (Date.now() - started);
    if (left < 4_000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(budget, left));
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
