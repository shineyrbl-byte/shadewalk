// Where the sun is in the sky, for any place and moment.
// Formulas from the astronomical algorithms used by SunCalc (Vladimir Agafonkin, BSD) and
// "Astronomy Answers" (Aphelion), accurate to a fraction of a degree, which is plenty for shadows.

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

const toDays = (ms: number) => ms / DAY_MS - 0.5 + J1970 - J2000;
const rightAscension = (l: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l));
const declination = (l: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(l));
const meanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d);
function eclipticLongitude(m: number) {
  const center = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  return m + center + RAD * 102.9372 + Math.PI;
}

export interface SunPosition {
  /** Degrees above the horizon (negative = below). */
  altitude: number;
  /** Compass bearing of the sun in degrees: 0 = north, 90 = east, 180 = south, 270 = west. */
  azimuth: number;
}

export function sunPosition(ms: number, lat: number, lon: number): SunPosition {
  const d = toDays(ms);
  const l = eclipticLongitude(meanAnomaly(d));
  const dec = declination(l);
  const ra = rightAscension(l);
  const phi = RAD * lat;
  const hourAngle = RAD * (280.16 + 360.9856235 * d) + RAD * lon - ra;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle));
  // atan2 gives the angle from south, positive towards west; turn it into a compass bearing
  const fromSouth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const azimuth = (fromSouth / RAD + 180 + 360) % 360;
  return { altitude: altitude / RAD, azimuth };
}

/** Minutes the zone is ahead of UTC at that instant (e.g. Phoenix = -420). */
export function tzOffsetMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The instant when the clock in `timeZone` reads `date` (YYYY-MM-DD) at `minutes` past midnight. */
export function zonedTime(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  // Two passes handle the hour around daylight-saving changes
  let t = guess - tzOffsetMinutes(guess, timeZone) * 60_000;
  t = guess - tzOffsetMinutes(t, timeZone) * 60_000;
  return t;
}

/** Today's date (YYYY-MM-DD) and minutes past midnight, as the clock reads in `timeZone`. */
export function nowIn(timeZone: string, ms = Date.now()): { date: string; minutes: number } {
  const local = new Date(ms + tzOffsetMinutes(ms, timeZone) * 60_000);
  const date = local.toISOString().slice(0, 10);
  return { date, minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
  const suffix = h < 12 ? "am" : "pm";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${suffix}`;
}

/** Sunrise and sunset (minutes past local midnight) found by scanning the day. */
export function daylight(date: string, timeZone: string, lat: number, lon: number): { rise: number; set: number } | null {
  let rise = -1, set = -1, prev = -90;
  for (let min = 0; min <= 1440; min += 5) {
    const alt = sunPosition(zonedTime(date, min, timeZone), lat, lon).altitude;
    if (prev <= 0 && alt > 0 && rise < 0) rise = min;
    if (prev > 0 && alt <= 0) set = min;
    prev = alt;
  }
  return rise < 0 ? null : { rise, set: set < 0 ? 1440 : set };
}
