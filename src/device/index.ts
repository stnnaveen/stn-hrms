// Device service layer. Screens call only these functions, never browser APIs directly.
// v1 (PWA): browser implementations below.
// v2 (Capacitor): swap the bodies for native plugins (mock flag, root check, Play Integrity / App Attest).
import { get, set } from 'idb-keyval';

export interface Fix {
  lat: number; lng: number; accuracy: number | null;
  altitude: number | null; speed: number | null;
  mocked: boolean | null;          // null = this platform cannot tell (PWA)
  at: string;                      // ISO time the reading was taken
}

export const platform = 'web';

/** A stable random id for this install. Clearing site data creates a "new phone" that Tech admin must allow. */
export async function deviceKey(): Promise<string> {
  let k: string | undefined;
  try { k = await get<string>('stn-device-key'); } catch { /* storage blocked */ }
  if (!k) {
    k = crypto.randomUUID();
    try { await set('stn-device-key', k); } catch { /* ignore */ }
  }
  return k;
}

/** Best GPS reading within `ms`: stops early once accuracy reaches `goodM` (PRD LC-02). */
export function bestFix(ms = 10000, goodM = 50): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('no_geolocation'));
    let best: GeolocationPosition | null = null;
    const done = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      if (!best) return reject(new Error('no_fix'));
      const c = best.coords;
      resolve({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? null, altitude: c.altitude ?? null,
        speed: c.speed ?? null, mocked: null, at: new Date(best.timestamp).toISOString() });
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        if (p.coords.accuracy <= goodM) done();
      },
      (err) => { if (err.code === err.PERMISSION_DENIED) { navigator.geolocation.clearWatch(id); clearTimeout(timer); reject(new Error('location_denied')); } },
      { enableHighAccuracy: true, maximumAge: 0, timeout: ms }
    );
    const timer = setTimeout(done, ms);
  });
}

export async function openFrontCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no_camera');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** JPEG of the live frame, unmirrored, max 960 px wide. Gallery upload is impossible by design (PRD FM-03). */
export async function captureJpeg(video: HTMLVideoElement): Promise<Blob> {
  const w = Math.min(960, video.videoWidth || 960);
  const h = Math.round(w * ((video.videoHeight || 720) / (video.videoWidth || 960)));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(video, 0, 0, w, h);
  return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('capture_failed'))), 'image/jpeg', 0.82));
}

export async function permissionsGranted(): Promise<boolean> {
  try {
    const [cam, geo] = await Promise.all([
      navigator.permissions.query({ name: 'camera' as PermissionName }),
      navigator.permissions.query({ name: 'geolocation' })
    ]);
    return cam.state === 'granted' && geo.state === 'granted';
  } catch { return false; } // Safari: unknown, ask in flow
}

// Small per-device flags (e.g. "greeting shown today"). v2 swaps this for Capacitor Preferences.
const istDay = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
/** True the first time it is called for `name` on this device each IST day. */
export function firstViewToday(name: string): boolean {
  try { const k = `stn-${name}`, d = istDay(), seen = localStorage.getItem(k) === d; localStorage.setItem(k, d); return !seen; }
  catch { return false; }
}
/** Forget daily flags, so the next sign-in shows the greeting again. */
export function clearDailyFlags() {
  try { for (const k of ['stn-greeted', 'stn-chair-intro']) localStorage.removeItem(k); } catch { /* private mode */ }
}
