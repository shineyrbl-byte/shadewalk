import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type L from "leaflet";
import MapView from "./components/MapView.tsx";
import DayChart from "./components/DayChart.tsx";
import { overpassQuery, parseOverpass, type Area } from "./lib/osm.ts";
import { projection } from "./lib/geo.ts";
import { ShadeModel, edgeSun } from "./lib/shade.ts";
import { buildGraph, findRoute, nearestNode, pathNodes, routeStats, type RouteStats } from "./lib/route.ts";
import { daylight, formatMinutes, nowIn, sunPosition, tzOffsetMinutes, zonedTime } from "./lib/sun.ts";
import { bestTime, dayProfile, networkShade, stopsNear, sunTraps } from "./lib/analysis.ts";

interface AreaInfo { id: string; name: string; city: string }

const params = new URLSearchParams(location.search);
const pair = (v: string | null) => (v ? (v.split(",").map(Number) as [number, number]) : null);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const STOP_WORDS: Record<string, [string, string]> = {
  water: ["💧", "drinking water"], bench: ["🪑", "bench"], shelter: ["⛱️", "shelter"], library: ["📚", "library"], toilets: ["🚻", "toilets"],
};

function summerDate() {
  return `${new Date().getFullYear()}-07-15`;
}

export default function App() {
  const [index, setIndex] = useState<AreaInfo[]>([]);
  const [area, setArea] = useState<Area | null>(null);
  const [loading, setLoading] = useState("Loading map data…");
  const [error, setError] = useState("");
  const [date, setDate] = useState(params.get("date") ?? summerDate());
  const [minutes, setMinutes] = useState(Number(params.get("t") ?? 16 * 60));
  const [start, setStart] = useState<[number, number] | null>(pair(params.get("a")));
  const [end, setEnd] = useState<[number, number] | null>(pair(params.get("b")));
  const [pinMode, setPinMode] = useState<"start" | "end">("end");
  const [heat, setHeat] = useState(3);
  const [showShadows, setShowShadows] = useState(true);
  const [showStreets, setShowStreets] = useState(false);
  const [showStops, setShowStops] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [tab, setTab] = useState<"walk" | "trees">("walk");
  const [copied, setCopied] = useState(false);
  const mapRef = useRef<L.Map | null>(null);

  const loadArea = useCallback(async (id: string, keepPins = false) => {
    setLoading("Loading map data…");
    setError("");
    try {
      const a: Area = await (await fetch(`/areas/${id}.json`)).json();
      setArea(a);
      if (!keepPins || !start || !end) { setStart(a.start ?? null); setEnd(a.end ?? null); }
    } catch {
      setError("Couldn't load that area.");
    } finally {
      setLoading("");
    }
  }, [start, end]);

  useEffect(() => {
    fetch("/areas/index.json").then((r) => r.json()).then((list: AreaInfo[]) => {
      setIndex(list);
      loadArea(params.get("area") ?? list[0].id, true);
    }).catch(() => setError("Couldn't load the list of areas."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const model = useMemo(() => (area ? new ShadeModel(area) : null), [area]);
  const graph = useMemo(() => (area ? buildGraph(area) : null), [area]);
  const proj = useMemo(() => (area ? projection(area.origin[0], area.origin[1]) : null), [area]);
  const day = useMemo(() => (area ? daylight(date, area.tz, area.origin[0], area.origin[1]) : null), [area, date]);

  // If an area has no suggested route, start and end near its middle
  useEffect(() => {
    if (!area || !proj || (start && end)) return;
    setStart(proj.toLatLon(-250, -150));
    setEnd(proj.toLatLon(250, 150));
  }, [area, proj, start, end]);

  // Sun, shadows and how sunny every street is, at the chosen moment
  const scene = useMemo(() => {
    if (!area || !model) return null;
    const pos = sunPosition(zonedTime(date, minutes, area.tz), area.origin[0], area.origin[1]);
    model.setSun(pos);
    const shadows = model.shadowPolygons();
    const { sun } = edgeSun(model, area);
    return { pos, shadows, sun, night: !model.up };
  }, [area, model, date, minutes]);

  const routes = useMemo(() => {
    if (!area || !graph || !scene || !proj || !start || !end) return null;
    const src = nearestNode(area, ...proj.toXY(...start));
    const dst = nearestNode(area, ...proj.toXY(...end));
    const sun = scene.sun;
    const shortest = findRoute(area, graph, src, dst, (e) => area.edges[e].len);
    const coolest = findRoute(area, graph, src, dst, (e) => area.edges[e].len * (1 + heat * sun[e]));
    if (!shortest || !coolest) return null;
    return {
      src,
      shortest: { edges: shortest, nodes: pathNodes(area, shortest, src), stats: routeStats(area, shortest, sun) },
      coolest: { edges: coolest, nodes: pathNodes(area, coolest, src), stats: routeStats(area, coolest, sun) },
    };
  }, [area, graph, scene, proj, start, end, heat]);

  // Shade on both routes across the day (paths fixed), for the chart and the best-time tip
  const coolKey = routes?.coolest.edges.join(",");
  const shortKey = routes?.shortest.edges.join(",");
  const profile = useMemo(() => {
    if (!area || !model || !routes || !day) return [];
    return dayProfile(model, area, [routes.coolest.edges, routes.shortest.edges], date, Math.ceil(day.rise / 15) * 15, Math.floor(day.set / 15) * 15, 15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, model, coolKey, shortKey, date, day]);
  const best = useMemo(() => bestTime(profile, 0, minutes), [profile, minutes]);

  const stops = useMemo(() => (area && routes ? stopsNear(area, routes.coolest.nodes) : []), [area, routes]);
  const traps = useMemo(() => (area && scene && !scene.night ? sunTraps(area, scene.sun) : []), [area, scene]);
  const netShade = useMemo(() => (area && scene ? networkShade(area, scene.sun) : 1), [area, scene]);

  // Keep the link shareable
  useEffect(() => {
    if (!area || !start || !end) return;
    const q = new URLSearchParams({ area: area.id, date, t: String(minutes), a: start.map((v) => v.toFixed(5)).join(","), b: end.map((v) => v.toFixed(5)).join(",") });
    if (area.id !== "custom") history.replaceState(null, "", `?${q}`);
  }, [area, date, minutes, start, end]);

  // Play the day: watch the shadows sweep across the streets
  useEffect(() => {
    if (!playing || !day) return;
    const t = setInterval(() => {
      setMinutes((m) => {
        if (m + 10 > day.set) { setPlaying(false); return day.set; }
        return m + 10;
      });
    }, 160);
    return () => clearInterval(t);
  }, [playing, day]);

  const scanView = async () => {
    const m = mapRef.current;
    if (!m) return;
    const b = m.getBounds();
    const s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
    const km2 = ((n - s) * 110.54) * ((e - w) * 111.32 * Math.cos(((s + n) / 2) * Math.PI / 180));
    if (km2 > 3.5) { setError(`That view is ${km2.toFixed(1)} km². Zoom in to under 3.5 km² (about a 1.8 km square) and try again.`); return; }
    setLoading("Downloading buildings, trees and streets from OpenStreetMap… (up to a minute)");
    setError("");
    try {
      const json = await fetchOverpass(overpassQuery(s, w, n, e));
      // Use this browser's time zone if it roughly matches the place, else local solar time
      const lon = (w + e) / 2;
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const solarOffset = Math.round(lon / 15);
      const tz = Math.abs(tzOffsetMinutes(Date.now(), browserTz) - solarOffset * 60) <= 150 ? browserTz : `Etc/GMT${solarOffset <= 0 ? "+" : "-"}${Math.abs(solarOffset)}`;
      const a = parseOverpass(json, { id: "custom", name: "Your area", city: "Scanned from OpenStreetMap", tz, bounds: [s, w, n, e] });
      if (a.edges.length < 10) throw new Error("No walkable streets found here.");
      setArea(a);
      setStart(null);
      setEnd(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading("");
    }
  };

  const pick = (ll: [number, number]) => (pinMode === "start" ? setStart(ll) : setEnd(ll));

  const useNow = () => {
    if (!area) return;
    const n = nowIn(area.tz);
    setDate(n.date);
    setMinutes(n.minutes);
  };

  const exportTraps = () => {
    if (!area || !proj) return;
    const rows = [["street", "metres in the area", "share in direct sun", "lat", "lon", "date", "time"]];
    for (const t of traps) {
      const [lat, lon] = proj.toLatLon(...t.mid);
      rows.push([t.name, t.length.toFixed(0), `${Math.round(t.sunShare * 100)}%`, lat.toFixed(5), lon.toFixed(5), date, formatMinutes(minutes)]);
    }
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `shadewalk-sun-traps-${area.id}-${date}.csv`;
    a.click();
  };

  const letter = () => {
    if (!area) return "";
    const list = traps.slice(0, 5).map((t, i) => `${i + 1}. ${t.name}: ${Math.round(t.length)} m, ${Math.round(t.sunShare * 100)}% in direct sun`).join("\n");
    return `Dear ${area.city.split(",")[0]} city council,

I walk in ${area.name}, and on hot afternoons some streets have almost no shade. I used Shadewalk, a free tool that models shade from buildings and trees using OpenStreetMap, to check ${new Date(date + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "long" })} at ${formatMinutes(minutes)}. These streets were the worst:

${list}

Across the area, only ${Math.round(netShade * 100)}% of the walking network was shaded at that time. The US EPA notes that shaded surfaces can be 11–25 °C cooler than unshaded ones, and extreme heat is most dangerous for older people, children and people who walk to work or school.

Could the council consider street trees or shade structures on these streets?

Thank you,
[Your name]`;
  };

  const copyLetter = async () => {
    await navigator.clipboard?.writeText(letter()).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const sunLine = scene && !scene.night
    ? `☀️ ${Math.round(scene.pos.altitude)}° high in the ${COMPASS[Math.round(scene.pos.azimuth / 45) % 8]} · a 10 m building casts a ${Math.round(10 / Math.tan((scene.pos.altitude * Math.PI) / 180))} m shadow`
    : "🌙 The sun is down. Every street is in the shade.";

  const c = routes?.coolest.stats, s = routes?.shortest.stats;
  const savedSun = c && s ? s.sunMinutes - c.sunMinutes : 0;
  const extra = c && s ? c.minutes - s.minutes : 0;
  const same = routes && routes.coolest.edges.join() === routes.shortest.edges.join();

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <h1>🌳 Shadewalk</h1>
          <p>Walking directions that keep you in the shade.</p>
        </header>

        <section className="block">
          <label className="label" htmlFor="area">Where</label>
          <div className="row">
            <select id="area" value={area?.id ?? ""} onChange={(e) => loadArea(e.target.value)}>
              {index.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.city}</option>)}
              {area?.id === "custom" && <option value="custom">Your scanned area</option>}
            </select>
            <button className="btn ghost" onClick={scanView} title="Download buildings, trees and streets for the area on screen">🔍 Scan this view</button>
          </div>
          <p className="hint">Anywhere in the world: move the map, zoom in to a neighbourhood, then scan it.</p>
        </section>

        <section className="block">
          <div className="row between">
            <label className="label" htmlFor="time">When: <strong>{formatMinutes(minutes)}</strong></label>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" />
          </div>
          <div className="row">
            <button className="btn icon" onClick={() => { if (!playing && day && minutes >= day.set - 10) setMinutes(day.rise); setPlaying((p) => !p); }} aria-label={playing ? "Pause" : "Play the day"}>{playing ? "⏸" : "▶"}</button>
            <input id="time" type="range" min={day ? Math.max(0, day.rise - 30) : 300} max={day ? Math.min(1439, day.set + 30) : 1260} step={5} value={minutes} onChange={(e) => { setPlaying(false); setMinutes(Number(e.target.value)); }} />
          </div>
          <div className="chips">
            <button className="chip" onClick={useNow}>Now</button>
            <button className="chip" onClick={() => { setDate(summerDate()); setMinutes(16 * 60); }}>Summer afternoon</button>
            <button className="chip" onClick={() => setMinutes(8 * 60)}>8am</button>
            <button className="chip" onClick={() => setMinutes(13 * 60)}>1pm</button>
            <button className="chip" onClick={() => setMinutes(18 * 60)}>6pm</button>
          </div>
          <p className="sunline">{sunLine}</p>
        </section>

        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "walk"} className={tab === "walk" ? "on" : ""} onClick={() => setTab("walk")}>🚶 My walk</button>
          <button role="tab" aria-selected={tab === "trees"} className={tab === "trees" ? "on" : ""} onClick={() => setTab("trees")}>🌱 Needs trees</button>
        </nav>

        {tab === "walk" ? (
          <>
            <section className="block">
              <div className="row">
                <span className="label">Tap the map to move</span>
                <div className="seg" role="radiogroup" aria-label="Which pin to move">
                  <button role="radio" aria-checked={pinMode === "start"} className={pinMode === "start" ? "on" : ""} onClick={() => setPinMode("start")}>A start</button>
                  <button role="radio" aria-checked={pinMode === "end"} className={pinMode === "end" ? "on" : ""} onClick={() => setPinMode("end")}>B destination</button>
                </div>
              </div>

              {scene?.night ? (
                <p className="callout night">🌙 The sun is down, so any route is shaded. Pick a daytime hour to compare.</p>
              ) : c && s ? (
                <>
                  <p className="headline">
                    {same ? (
                      <>The shortest route is already the coolest: <strong>{Math.round(c.shade * 100)}% shade</strong>.</>
                    ) : (
                      <>{extra < 0.5 ? <><strong>Almost no extra walking</strong> and</> : <><strong>+{extra.toFixed(1)} min</strong> of walking for</>} <strong>{savedSun.toFixed(1)} fewer minutes</strong> in direct sun.</>
                    )}
                  </p>
                  <div className="cards">
                    <RouteCard title="🌳 Coolest" stats={c} cls="cool" />
                    <RouteCard title="📏 Shortest" stats={s} cls="short" />
                  </div>
                  <label className="label" htmlFor="heat">How much do you want to avoid the sun?</label>
                  <input id="heat" type="range" min={0.5} max={10} step={0.5} value={heat} onChange={(e) => setHeat(Number(e.target.value))} />
                  <div className="range-labels"><span>a little</span><span>at all costs</span></div>
                </>
              ) : (
                <p className="muted">{loading || "Finding routes…"}</p>
              )}
            </section>

            {!scene?.night && best && c && (
              <section className="block">
                <h2>⏰ Best time to leave</h2>
                {best.min === minutes || best.shade[0] - c.shade < 0.04 ? (
                  <p>Now is about as shady as it gets in the next two hours.</p>
                ) : (
                  <p>
                    Leave at <button className="link" onClick={() => setMinutes(best.min)}>{formatMinutes(best.min)}</button> and the coolest route is{" "}
                    <strong>{Math.round(best.shade[0] * 100)}% shaded</strong> (vs {Math.round(c.shade * 100)}% now).
                  </p>
                )}
                <DayChart profile={profile} now={minutes} best={best.min} onPick={(m) => { setPlaying(false); setMinutes(m); }} />
              </section>
            )}

            {stops.length > 0 && (
              <section className="block">
                <h2>🧊 Cool stops on the way</h2>
                <ul className="stops">
                  {Object.entries(stops.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {})).map(([k, n]) => (
                    <li key={k}>{STOP_WORDS[k][0]} {n} {STOP_WORDS[k][1]}{n > 1 && k !== "toilets" ? (k === "bench" ? "es" : "s") : ""}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <section className="block">
            <h2>Sun traps at {formatMinutes(minutes)}</h2>
            <p className="muted">
              Only <strong>{Math.round(netShade * 100)}%</strong> of the walking network here is shaded right now. These named streets are the
              longest stretches in full sun: the places a row of trees or a shade sail would help walkers most.
            </p>
            {traps.length === 0 ? (
              <p className="muted">{scene?.night ? "The sun is down." : "No big sun traps at this time. Try 1pm in summer."}</p>
            ) : (
              <>
                <ol className="traps">
                  {traps.map((t) => (
                    <li key={t.name}>
                      <button className="link" onClick={() => { setShowStreets(true); setFocus([...t.mid]); }}>{t.name}</button>
                      <span className="muted"> · {Math.round(t.length)} m · {Math.round(t.sunShare * 100)}% sun</span>
                    </li>
                  ))}
                </ol>
                <div className="row">
                  <button className="btn" onClick={copyLetter}>{copied ? "✓ Copied" : "✉️ Copy a letter to your council"}</button>
                  <button className="btn ghost" onClick={exportTraps}>⬇ CSV</button>
                </div>
                <details className="letter">
                  <summary>Preview the letter</summary>
                  <pre>{letter()}</pre>
                </details>
              </>
            )}
          </section>
        )}

        <section className="block layers">
          <h2>Map layers</h2>
          <label><input type="checkbox" checked={showShadows} onChange={(e) => setShowShadows(e.target.checked)} /> Shadows</label>
          <label><input type="checkbox" checked={showStreets} onChange={(e) => setShowStreets(e.target.checked)} /> Street shade map <span className="legend"><i className="lg shade" />shade <i className="lg mixed" />mixed <i className="lg sun" />sun</span></label>
          <label><input type="checkbox" checked={showStops} onChange={(e) => setShowStops(e.target.checked)} /> Cool stops (💧 ⛱️ 📚 🚻)</label>
        </section>

        <footer className="about">
          <details>
            <summary>How it works & limits</summary>
            <p>
              Shadewalk calculates where the sun is for the place and time you pick, then casts a ray from each point on each street towards the sun.
              If the ray passes through a building (below its roof) or a tree canopy, that spot is in shade. The coolest route makes sunny metres count
              extra, and it picks the shadier sidewalk on wider roads.
            </p>
            <p>
              Data comes from OpenStreetMap. Where a building has no height, Shadewalk guesses from its floors or type, and trees that aren't mapped can't
              cast shade, so real streets may be a bit shadier. {area?.stats && <>This area has {area.trees.length.toLocaleString()} mapped trees and {area.buildings.length.toLocaleString()} buildings ({area.stats.buildingsWithHeight} with known heights).</>}
            </p>
            <p>Heat can be dangerous. Carry water, and on extreme heat days walk early or late if you can.</p>
          </details>
          <p className="muted small">Made for Code for Change 2026 · <a href="https://github.com/shineyrbl-byte/shadewalk" target="_blank" rel="noreferrer">Source</a> · Map data © OpenStreetMap contributors</p>
        </footer>
      </aside>

      <main className="map-wrap">
        {area && scene && start && end ? (
          <MapView
            area={area}
            shadows={scene.shadows}
            sun={scene.sun}
            night={scene.night}
            showShadows={showShadows}
            showStreets={showStreets}
            showStops={showStops}
            start={start}
            end={end}
            coolest={routes?.coolest ?? null}
            shortest={routes && !same ? routes.shortest : null}
            stops={stops}
            focus={focus}
            onPick={pick}
            onMoveStart={setStart}
            onMoveEnd={setEnd}
            onMapReady={(m) => (mapRef.current = m)}
          />
        ) : (
          <div className="map placeholder">{error || loading || "Loading…"}</div>
        )}
        {(loading || error) && area && <div className={`toast${error ? " error" : ""}`} role="status">{error || loading}{error && <button className="link" onClick={() => setError("")}>dismiss</button>}</div>}
      </main>
    </div>
  );
}

// Downloads go through our own proxy (/api/overpass), because OpenStreetMap's Overpass servers
// reject browser user agents. In local development there's no proxy, so it calls a mirror directly.
async function fetchOverpass(query: string) {
  const attempts: [string, RequestInit][] = location.hostname === "localhost"
    ? [["https://overpass.private.coffee/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(query) }]]
    : [["/api/overpass", { method: "POST", body: query }]];
  let last = "";
  for (const [url, init] of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 65_000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.ok) return await res.json();
      last = `error ${res.status}`;
    } catch (e) {
      last = (e as Error).name === "AbortError" ? "timed out" : "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`OpenStreetMap's servers are busy right now (${last}). Try again in a minute.`);
}

function RouteCard({ title, stats, cls }: { title: string; stats: RouteStats; cls: string }) {
  return (
    <div className={`card ${cls}`}>
      <h3>{title}</h3>
      <div className="big">{Math.round(stats.shade * 100)}%<span> shade</span></div>
      <div className="bar" aria-hidden><span style={{ width: `${stats.shade * 100}%` }} /></div>
      <p>{(stats.length / 1000).toFixed(2)} km · {Math.round(stats.minutes)} min</p>
      <p className="muted">{stats.sunMinutes.toFixed(1)} min in direct sun</p>
    </div>
  );
}
