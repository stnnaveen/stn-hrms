// Pure attendance rules: no I/O, so they run the same in the edge function and in tests.
// Every decision about a punch is made here, on the server. Nothing in this file is sent to staff.

export type Band = 'ok' | 'warn' | 'bad';
export type FlagKind =
  | 'late' | 'radius' | 'location_changer' | 'mock_location' | 'face' | 'liveness'
  | 'device' | 'clock' | 'offline' | 'jump' | 'early_out';

export interface Settings {
  officeStart: string;      // "10:00"
  lateUntil: string;        // "10:15"
  officeEnd: string;        // "18:00"
  faceThreshold: number;    // 80
  samePointDays: number;    // 5
  offlineFlagMinutes: number; // 30
  clockGapMinutes: number;  // 2
  jumpKmh: number;          // 150
}

export interface Fix {
  lat: number; lng: number; accuracy: number | null;
  altitude?: number | null; speed?: number | null; mocked?: boolean | null;
}

export interface Target { lat: number; lng: number; radiusM: number }
export interface PrevPunch { lat: number; lng: number; accuracy: number | null; at: Date }
export interface Liveness { challenge: string; passed: boolean }

export interface Evaluation {
  band: Band | null;
  earlyOut: boolean;
  distanceM: number;
  inside: boolean;
  flags: { kind: FlagKind; rule: string; details: Record<string, unknown> }[];
  quality: number;
  status: 'recorded' | 'review';
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Minutes since midnight in India time (UTC+5:30, no DST). */
export function istMinutes(d: Date): number {
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
  return m;
}

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** On time by 10:00, slightly late to 10:15, late after (PRD: strict, no grace). */
export function bandFor(at: Date, s: Settings): Band {
  const m = istMinutes(at);
  if (m <= toMin(s.officeStart)) return 'ok';
  if (m <= toMin(s.lateUntil)) return 'warn';
  return 'bad';
}

/** Spread of points in metres: max distance from their centroid. */
export function spreadM(points: { lat: number; lng: number }[]): number {
  if (points.length === 0) return Infinity;
  const c = { lat: points.reduce((a, p) => a + p.lat, 0) / points.length, lng: points.reduce((a, p) => a + p.lng, 0) / points.length };
  return Math.max(...points.map((p) => haversineM(c, p)));
}

export function evaluate(input: {
  kind: 'in' | 'out';
  serverTime: Date;
  clientTime: Date;
  fix: Fix;
  target: Target;
  faceSimilarity: number | null;     // null = no approved reference photo yet
  liveness: Liveness | null;
  recentDays: PrevPunch[];           // earlier check-ins, one per day, newest first (same-point check)
  lastPunch: PrevPunch | null;       // the person's previous punch of any kind (jump check)
  integrityOk: boolean | null;       // null = not available on this platform (PWA)
  settings: Settings;
}): Evaluation {
  const { kind, serverTime, clientTime, fix, target, faceSimilarity, liveness, recentDays, lastPunch, integrityOk, settings: s } = input;
  const flags: Evaluation['flags'] = [];
  let quality = 100;

  // Location: outside when distance minus accuracy exceeds the radius; accuracy credit capped at 100 m
  const distanceM = haversineM(fix, target);
  const credit = Math.min(fix.accuracy ?? 0, 100);
  const inside = distanceM - credit <= target.radiusM;
  if (!inside) flags.push({ kind: 'radius', rule: `R-02 distance > ${target.radiusM} m`, details: { distance_m: Math.round(distanceM), accuracy_m: fix.accuracy } });

  // Time
  let band: Band | null = null;
  let earlyOut = false;
  if (kind === 'in') {
    band = bandFor(serverTime, s);
    if (band === 'bad') flags.push({ kind: 'late', rule: `R-01 check-in after ${s.lateUntil}`, details: { ist_minutes: istMinutes(serverTime) } });
  } else {
    earlyOut = istMinutes(serverTime) < toMin(s.officeEnd);
    if (earlyOut) flags.push({ kind: 'early_out', rule: `R-07 check-out before ${s.officeEnd}`, details: { ist_minutes: istMinutes(serverTime) } });
  }

  // Clock and offline: a late sync is offline; a big gap on a live sync is a changed clock
  const lagMin = (serverTime.getTime() - clientTime.getTime()) / 60000;
  if (lagMin > s.offlineFlagMinutes) {
    flags.push({ kind: 'offline', rule: `R-09 synced ${Math.round(lagMin)} min late`, details: { lag_min: Math.round(lagMin) } });
    quality -= 10;
  } else if (Math.abs(lagMin) > s.clockGapMinutes) {
    flags.push({ kind: 'clock', rule: `R-08 phone clock off by ${Math.round(lagMin)} min`, details: { lag_min: Math.round(lagMin) } });
    quality -= 15;
  }

  // Fake location signals
  if (fix.mocked === true) {
    flags.push({ kind: 'mock_location', rule: 'R-03 mock location on', details: {} });
    quality -= 45;
  }
  const window = [fix, ...recentDays].slice(0, s.samePointDays);
  if (window.length >= s.samePointDays) {
    const spread = spreadM(window);
    const accs = new Set(window.map((p) => p.accuracy));
    if (spread < 1 && accs.size === 1) {
      flags.push({ kind: 'location_changer', rule: `R-04 same point ${s.samePointDays}+ days, spread < 1 m`, details: { spread_m: Number(spread.toFixed(2)) } });
      quality -= 45;
    }
  }
  if (lastPunch) {
    const hours = (serverTime.getTime() - lastPunch.at.getTime()) / 3.6e6;
    const km = haversineM(fix, lastPunch) / 1000;
    if (hours > 0 && km / hours > s.jumpKmh && km > 5) {
      flags.push({ kind: 'jump', rule: `R-10 implied speed over ${s.jumpKmh} km/h`, details: { km: Number(km.toFixed(1)), hours: Number(hours.toFixed(2)) } });
      quality -= 25;
    }
  }
  if (integrityOk === false) {
    flags.push({ kind: 'device', rule: 'R-06 device integrity failed', details: {} });
    quality -= 30;
  }
  if (fix.accuracy == null || fix.accuracy > 100) quality -= 10;

  // Face and liveness
  if (liveness && !liveness.passed) {
    flags.push({ kind: 'liveness', rule: 'R-11 liveness prompt not passed', details: { challenge: liveness.challenge } });
    quality -= 20;
  }
  if (faceSimilarity !== null && faceSimilarity < s.faceThreshold) {
    flags.push({ kind: 'face', rule: `R-05 face match below ${s.faceThreshold}%`, details: { similarity: Math.round(faceSimilarity) } });
  }

  const review = flags.some((f) => ['face', 'liveness', 'mock_location', 'location_changer', 'jump', 'device', 'radius'].includes(f.kind));
  return { band, earlyOut, distanceM, inside, flags, quality: Math.max(0, Math.min(100, quality)), status: review ? 'review' : 'recorded' };
}

export const DEFAULT_SETTINGS: Settings = {
  officeStart: '10:00', lateUntil: '10:15', officeEnd: '18:00', faceThreshold: 80,
  samePointDays: 5, offlineFlagMinutes: 30, clockGapMinutes: 2, jumpKmh: 150
};
