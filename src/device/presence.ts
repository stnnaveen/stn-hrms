// Work-hours presence for the STORE APP only (Capacitor, v2). The browser app never runs this.
// Between check-in and check-out, inside office hours, the phone takes location fixes in the background and
// queues small samples; the server decides inside/outside (CLAUDE.md rule 1). Nothing here judges or shows it.
// Battery: GPS updates only after ~25 m of movement; a "still here" beat every 5 min while stationary, so the
// server can tell a quiet desk from a phone that stopped sending.
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin, Location } from '@capacitor-community/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';

export interface PresenceSample { lat: number; lng: number; accuracy: number | null; time: number; source: 'watch' | 'beat' }
const BG = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');
const KEY = 'stn.presence.queue';
const SAMPLE_MS = 3 * 60000, BEAT_MS = 5 * 60000, FLUSH_MS = 3 * 60000, MOVE_M = 30;

export const isStoreApp = () => Capacitor.isNativePlatform();

let watcher: string | null = null;
let sender: ((s: PresenceSample[]) => Promise<boolean>) | null = null;
let lastFix: Location | null = null;
let lastQueued: PresenceSample | null = null;
let timers: number[] = [];
let stopAt = 0;

const load = (): PresenceSample[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } };
const save = (q: PresenceSample[]) => { try { localStorage.setItem(KEY, JSON.stringify(q.slice(-500))); } catch { /* memory only */ } };
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
};
function queue(s: PresenceSample) { const q = load(); q.push(s); save(q); lastQueued = s; }

async function flush() {
  const q = load();
  if (!q.length || !sender) return;
  const batch = q.slice(0, 100);
  if (await sender(batch).catch(() => false)) save(load().slice(batch.length));
}

function onFix(loc?: Location) {
  if (!loc) return;
  lastFix = loc;
  const s: PresenceSample = { lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy ?? null, time: loc.time ?? Date.now(), source: 'watch' };
  if (!lastQueued || s.time - lastQueued.time >= SAMPLE_MS || metres(lastQueued, s) >= MOVE_M) queue(s);
}

/** Start (or keep) background location until `until` (ms). Safe to call often; does nothing in the browser. */
export async function startPresence(send: (s: PresenceSample[]) => Promise<boolean>, until: number): Promise<'on' | 'off' | 'denied'> {
  if (!isStoreApp() || Date.now() >= until) { await stopPresence(); return 'off'; }
  sender = send; stopAt = until;
  if (watcher) return 'on';
  try { await LocalNotifications.requestPermissions(); } catch { /* Android 13+ notification; tracking still starts */ }
  let denied = false;
  watcher = await BG.addWatcher({
    backgroundTitle: 'StartupTN HR',
    backgroundMessage: 'Work-hours location is on until check-out.',
    requestPermissions: true, stale: false, distanceFilter: 25
  }, (loc, err) => { if (err) { if (err.code === 'NOT_AUTHORIZED') denied = true; return; } onFix(loc); });
  timers.push(window.setInterval(() => {
    if (Date.now() >= stopAt) { void flush().finally(() => stopPresence()); return; }
    // still at the same spot: a beat with the last fix, so silence always means "not sending"
    if (lastFix && (!lastQueued || Date.now() - lastQueued.time >= BEAT_MS)) queue({ lat: lastFix.latitude, lng: lastFix.longitude, accuracy: lastFix.accuracy ?? null, time: Date.now(), source: 'beat' });
  }, 60000));
  timers.push(window.setInterval(() => { void flush(); }, FLUSH_MS));
  void flush();
  return denied ? 'denied' : 'on';
}

export async function stopPresence() {
  timers.forEach((t) => clearInterval(t)); timers = [];
  if (watcher) { const id = watcher; watcher = null; await BG.removeWatcher({ id }).catch(() => undefined); }
  await flush().catch(() => undefined);
  lastFix = null; lastQueued = null;
}

/** Location settings page (when the person refused location). */
export const openLocationSettings = () => BG.openSettings().catch(() => undefined);
