// Real temperatures for the chosen place and day, from Open-Meteo (free, no key, CORS-friendly).
// Recent and future days come from the forecast API (up to ~16 days ahead), older days from the archive.

export interface Hourly {
  temp: (number | null)[]; // °C, index = local hour 0..23
  feels: (number | null)[]; // "feels like" (apparent temperature), °C
  uv: (number | null)[] | null;
  source: "forecast" | "archive";
}

export async function fetchHourly(lat: number, lon: number, date: string, tz: string): Promise<Hourly | null> {
  const zone = tz.startsWith("Etc/") ? "auto" : tz;
  const base = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timezone=${encodeURIComponent(zone)}&start_date=${date}&end_date=${date}`;
  const forecast: [string, Hourly["source"]] = [`https://api.open-meteo.com/v1/forecast?${base}&hourly=temperature_2m,apparent_temperature,uv_index`, "forecast"];
  const archive: [string, Hourly["source"]] = [`https://archive-api.open-meteo.com/v1/archive?${base}&hourly=temperature_2m,apparent_temperature`, "archive"];
  // The forecast API covers roughly the last 3 months to 16 days ahead; older days are in the archive
  const daysAway = (Date.parse(date + "T12:00:00Z") - Date.now()) / 86_400_000;
  if (daysAway > 16) return null;
  const tries = daysAway < -80 ? [archive] : [forecast, archive];
  for (const [url, source] of tries) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      const temp: (number | null)[] = j.hourly?.temperature_2m ?? [];
      if (!temp.some((v) => v !== null)) continue;
      return { temp, feels: j.hourly.apparent_temperature ?? temp, uv: j.hourly.uv_index ?? null, source };
    } catch {
      /* try the next source */
    }
  }
  return null;
}

/** Value at `minutes` past midnight, interpolated between hours. */
export function atMinute(series: (number | null)[] | null | undefined, minutes: number): number | null {
  if (!series?.length) return null;
  const h = Math.min(23, Math.floor(minutes / 60)), f = (minutes % 60) / 60;
  const a = series[h], b = series[Math.min(23, h + 1)];
  if (a == null) return b ?? null;
  if (b == null) return a;
  return a + (b - a) * f;
}

export interface HeatLevel { level: 0 | 1 | 2 | 3 | 4; label: string; advice: string }

/** US National Weather Service heat index categories, applied to the "feels like" temperature. */
export function heatLevel(feelsC: number | null): HeatLevel {
  if (feelsC == null || feelsC < 27) return { level: 0, label: "", advice: "" };
  if (feelsC < 32) return { level: 1, label: "Caution", advice: "Tiring with long exposure. Shade and water help." };
  if (feelsC < 39) return { level: 2, label: "Extreme caution", advice: "Heat cramps and exhaustion are possible. Walk in the shade, carry water and take breaks." };
  if (feelsC < 52) return { level: 3, label: "Danger", advice: "Heat exhaustion is likely, and heatstroke is possible with long exposure. Keep walks short and shaded, or go early or late." };
  return { level: 4, label: "Extreme danger", advice: "Heatstroke is highly likely. Avoid walking outside in the heat of the day if you can." };
}
