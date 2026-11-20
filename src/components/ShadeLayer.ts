// A Leaflet layer that draws buildings, trees and their shadows (and optionally a sun/shade map
// of every street) on one canvas. Thousands of shapes redraw in a few milliseconds, so shadows
// can follow the time slider live.
import L from "leaflet";
import type { Area } from "../lib/osm.ts";
import type { Pt } from "../lib/geo.ts";
import { projection } from "../lib/geo.ts";

export interface ShadeLayerData {
  area: Area;
  shadows: { buildings: Pt[][]; trees: Pt[][] };
  sun: Float32Array | null; // per edge, for the street shade map
  showShadows: boolean;
  showStreets: boolean;
  night: boolean;
}

const PAD = 0.35; // draw beyond the viewport so panning doesn't reveal blank edges

export class ShadeLayer extends L.Layer {
  private canvas = document.createElement("canvas");
  private data: ShadeLayerData | null = null;
  private frame = 0;
  private mapRef: L.Map | null = null;

  onAdd(map: L.Map) {
    this.mapRef = map;
    const pane = map.getPane("shade") ?? map.createPane("shade");
    pane.style.zIndex = "350";
    pane.style.pointerEvents = "none";
    this.canvas.className = "shade-canvas leaflet-zoom-hide";
    pane.appendChild(this.canvas);
    map.on("moveend zoomend resize", this.schedule, this);
    this.schedule();
    return this;
  }

  onRemove(map: L.Map) {
    map.off("moveend zoomend resize", this.schedule, this);
    this.canvas.remove();
    this.mapRef = null;
    return this;
  }

  setData(d: ShadeLayerData) {
    this.data = d;
    this.schedule();
  }

  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    const map = this.mapRef, d = this.data;
    if (!map || !d) return;
    const size = map.getSize();
    const w = Math.round(size.x * (1 + 2 * PAD)), h = Math.round(size.y * (1 + 2 * PAD));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.canvas;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr; c.height = h * dpr;
      c.style.width = `${w}px`; c.style.height = `${h}px`;
    }
    const offX = size.x * PAD, offY = size.y * PAD;
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([-offX, -offY]));
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Local metres → screen pixels. Web Mercator is effectively linear across one neighbourhood.
    const { area } = d;
    const proj = projection(area.origin[0], area.origin[1]);
    const o = map.latLngToContainerPoint(area.origin);
    const ex = map.latLngToContainerPoint(proj.toLatLon(100, 0));
    const ny = map.latLngToContainerPoint(proj.toLatLon(0, 100));
    const sx = (ex.x - o.x) / 100, sy = (ny.y - o.y) / 100;
    const X = (x: number) => o.x + offX + x * sx;
    const Y = (y: number) => o.y + offY + y * sy;
    const zoom = map.getZoom();

    const path = (pts: Pt[]) => {
      ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]));
      ctx.closePath();
    };

    // Shadows: one path, filled once, so overlapping shadows don't get darker (shade is shade)
    if (d.showShadows && !d.night) {
      ctx.beginPath();
      for (const s of d.shadows.buildings) if (s.length > 2) path(s);
      for (const s of d.shadows.trees) if (s.length > 2) path(s);
      ctx.fillStyle = "rgba(37, 56, 140, 0.34)";
      ctx.fill("nonzero");
    }

    // Street shade map
    if (d.showStreets && d.sun) {
      const n = area.nodes;
      ctx.lineCap = "round";
      ctx.lineWidth = zoom >= 17 ? 4 : 2.5;
      const buckets: [string, (s: number) => boolean][] = [
        ["rgba(14, 116, 144, 0.9)", (s) => s < 0.25],
        ["rgba(250, 204, 21, 0.95)", (s) => s >= 0.25 && s < 0.6],
        ["rgba(234, 88, 12, 0.95)", (s) => s >= 0.6],
      ];
      for (const [color, test] of buckets) {
        ctx.beginPath();
        area.edges.forEach((e, i) => {
          if (!test(d.sun![i])) return;
          ctx.moveTo(X(n[e.a * 2]), Y(n[e.a * 2 + 1]));
          ctx.lineTo(X(n[e.b * 2]), Y(n[e.b * 2 + 1]));
        });
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    }

    // Buildings
    ctx.beginPath();
    for (const b of area.buildings) {
      const p = b.poly;
      ctx.moveTo(X(p[0]), Y(p[1]));
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(X(p[i]), Y(p[i + 1]));
      ctx.closePath();
    }
    ctx.fillStyle = d.night ? "rgba(71, 85, 105, 0.85)" : "rgba(250, 248, 243, 0.96)";
    ctx.fill();
    if (zoom >= 16) {
      ctx.strokeStyle = d.night ? "rgba(148, 163, 184, 0.5)" : "rgba(100, 116, 139, 0.55)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Tree canopies
    ctx.beginPath();
    const px = Math.abs(sx);
    for (const t of area.trees) {
      const r = Math.max(1.2, t.r * px);
      ctx.moveTo(X(t.x) + r, Y(t.y));
      ctx.arc(X(t.x), Y(t.y), r, 0, Math.PI * 2);
    }
    ctx.fillStyle = d.night ? "rgba(34, 94, 60, 0.6)" : "rgba(34, 139, 74, 0.55)";
    ctx.fill();
  }
}
