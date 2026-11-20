import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Area, Poi } from "../lib/osm.ts";
import type { Pt } from "../lib/geo.ts";
import { projection } from "../lib/geo.ts";
import { ShadeLayer } from "./ShadeLayer.ts";

export interface RouteLine { nodes: number[]; edges: number[] }

interface Props {
  area: Area;
  shadows: { buildings: Pt[][]; trees: Pt[][] };
  sun: Float32Array | null;
  night: boolean;
  showShadows: boolean;
  showStreets: boolean;
  showStops: boolean;
  start: [number, number];
  end: [number, number];
  coolest: RouteLine | null;
  shortest: RouteLine | null;
  stops: Poi[];
  focus: [number, number] | null; // local x, y to fly to
  onPick: (latlng: [number, number]) => void;
  onMoveStart: (latlng: [number, number]) => void;
  onMoveEnd: (latlng: [number, number]) => void;
  onMapReady?: (map: L.Map) => void;
}

const STOP_ICON: Record<Poi["kind"], string> = { water: "💧", bench: "🪑", shelter: "⛱️", library: "📚", toilets: "🚻" };
const STOP_LABEL: Record<Poi["kind"], string> = { water: "Drinking water", bench: "Bench", shelter: "Shelter", library: "Library (air-conditioned)", toilets: "Toilets" };

const pin = (label: string, cls: string) =>
  L.divIcon({ className: `pin ${cls}`, html: `<span><b>${label}</b></span>`, iconSize: [34, 34], iconAnchor: [17, 34] });

export default function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const shade = useRef<ShadeLayer | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const stopLayer = useRef<L.LayerGroup | null>(null);
  const markers = useRef<{ a: L.Marker; b: L.Marker } | null>(null);
  const cb = useRef(p);
  cb.current = p;

  // Create the map once
  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false, preferCanvas: false, maxZoom: 19, minZoom: 13 });
    L.control.zoom({ position: "bottomright" }).addTo(m);
    shade.current = new ShadeLayer().addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    stopLayer.current = L.layerGroup().addTo(m);
    const a = L.marker([0, 0], { draggable: true, icon: pin("A", "pin-a"), keyboard: true, title: "Start (drag to move)" }).addTo(m);
    const b = L.marker([0, 0], { draggable: true, icon: pin("B", "pin-b"), keyboard: true, title: "Destination (drag to move)" }).addTo(m);
    a.on("dragend", () => { const ll = a.getLatLng(); cb.current.onMoveStart([ll.lat, ll.lng]); });
    b.on("dragend", () => { const ll = b.getLatLng(); cb.current.onMoveEnd([ll.lat, ll.lng]); });
    m.on("click", (e: L.LeafletMouseEvent) => cb.current.onPick([e.latlng.lat, e.latlng.lng]));
    markers.current = { a, b };
    map.current = m;
    cb.current.onMapReady?.(m);
    return () => { m.remove(); map.current = null; };
  }, []);

  // Day/night base map
  useEffect(() => {
    const m = map.current!;
    tiles.current?.remove();
    // Standard OpenStreetMap tiles (free with attribution, light use), muted with a CSS filter
    // so shadows and routes stand out. At night the filter darkens them.
    tiles.current = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      className: p.night ? "tiles-night" : "tiles-day",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    tiles.current.bringToBack();
  }, [p.night]);

  // New area: fit to it
  useEffect(() => {
    const m = map.current!;
    const [s, w, n, e] = p.area.bounds;
    m.setMaxBounds(L.latLngBounds([s - 0.01, w - 0.012], [n + 0.01, e + 0.012]));
    // Open framed on the route (both pins), else the whole area
    if (p.start && p.end) m.fitBounds(L.latLngBounds([p.start, p.end]), { padding: [50, 50], maxZoom: 17 });
    else m.fitBounds([[s, w], [n, e]], { padding: [10, 10] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.area]);

  useEffect(() => {
    shade.current?.setData({ area: p.area, shadows: p.shadows, sun: p.sun, showShadows: p.showShadows, showStreets: p.showStreets, night: p.night });
  }, [p.area, p.shadows, p.sun, p.showShadows, p.showStreets, p.night]);

  useEffect(() => {
    markers.current?.a.setLatLng(p.start);
    markers.current?.b.setLatLng(p.end);
  }, [p.start, p.end]);

  // Routes: shortest as a grey dashed line, coolest coloured by sun and shade
  useEffect(() => {
    const g = routeLayer.current!;
    g.clearLayers();
    const proj = projection(p.area.origin[0], p.area.origin[1]);
    const n = p.area.nodes;
    const ll = (i: number) => proj.toLatLon(n[i * 2], n[i * 2 + 1]);
    if (p.shortest) {
      L.polyline(p.shortest.nodes.map(ll), { color: "#334155", weight: 5, opacity: 0.85, dashArray: "1 10", lineCap: "round", interactive: false }).addTo(g);
    }
    if (p.coolest && p.sun) {
      const pts = p.coolest.nodes.map(ll);
      L.polyline(pts, { color: "#ffffff", weight: 10, opacity: 0.95, lineCap: "round", lineJoin: "round", interactive: false }).addTo(g);
      // Group consecutive edges by sunny / shady
      let runStart = 0;
      const sunny = (k: number) => p.sun![p.coolest!.edges[k]] >= 0.5;
      for (let k = 1; k <= p.coolest.edges.length; k++) {
        if (k === p.coolest.edges.length || sunny(k) !== sunny(runStart)) {
          L.polyline(pts.slice(runStart, k + 1), {
            color: sunny(runStart) ? "#f97316" : "#0f766e", weight: 6, opacity: 1, lineCap: "round", lineJoin: "round", interactive: false,
          }).addTo(g);
          runStart = k;
        }
      }
    }
  }, [p.area, p.coolest, p.shortest, p.sun]);

  // Cool stops
  useEffect(() => {
    const g = stopLayer.current!;
    g.clearLayers();
    if (!p.showStops) return;
    const proj = projection(p.area.origin[0], p.area.origin[1]);
    const near = new Set(p.stops);
    for (const s of p.area.pois) {
      if (s.kind === "bench" && !near.has(s)) continue; // benches only near your route, or the map gets busy
      const icon = L.divIcon({ className: `stop${near.has(s) ? " near" : ""}`, html: STOP_ICON[s.kind], iconSize: [24, 24] });
      L.marker(proj.toLatLon(s.x, s.y), { icon, keyboard: false, title: STOP_LABEL[s.kind] })
        .bindTooltip(`${STOP_LABEL[s.kind]}${s.name ? `: ${s.name}` : ""}`)
        .addTo(g);
    }
  }, [p.area, p.stops, p.showStops]);

  useEffect(() => {
    if (!p.focus || !map.current) return;
    const proj = projection(p.area.origin[0], p.area.origin[1]);
    map.current.flyTo(proj.toLatLon(p.focus[0], p.focus[1]), 18, { duration: 0.8 });
  }, [p.focus, p.area]);

  return <div ref={el} className="map" role="application" aria-label="Map showing shadows and your route. Click to move your destination; drag the A and B pins." />;
}
