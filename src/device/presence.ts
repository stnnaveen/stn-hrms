// Work-hours presence for the STORE APP only (Capacitor, v2). The browser app never runs this.
// Uses the Transistorsoft background-location SDK: it keeps recording after the app is closed or swiped away,
// restarts after a reboot, turns GPS off while the phone is still (motion sensors wake it when it moves), and
// posts samples itself in the background with a long-lived phone token. The server decides inside/outside
// (CLAUDE.md rule 1); nothing here judges or shows it.
// Licence: free in debug (pilot) builds; a licence key is needed for Play Store / App Store release builds.
import { Capacitor } from '@capacitor/core';
import BackgroundGeolocation from '@transistorsoft/capacitor-background-geolocation';

export const isStoreApp = () => Capacitor.isNativePlatform();

let configured = '';
let beat: { remove: () => void } | null = null;

/** Start (or keep) background location until `until` (ms). Safe to call often; does nothing in the browser. */
export async function startPresence(o: { url: string; anonKey: string; token: string; until: number }): Promise<'on' | 'off'> {
  if (!isStoreApp() || Date.now() >= o.until) { await stopPresence(); return 'off'; }
  const minutes = Math.max(1, Math.round((o.until - Date.now()) / 60000));
  const key = `${o.token}|${o.until}`;
  if (configured !== key) {
    await BackgroundGeolocation.ready({
      reset: true,
      geolocation: {
        desiredAccuracy: BackgroundGeolocation.DesiredAccuracy.High,
        distanceFilter: 25, stationaryRadius: 25, stopTimeout: 5,
        stopAfterElapsedMinutes: minutes,                 // ends itself at office close even if nobody checks out
        locationAuthorizationRequest: 'Always'            // keeps working when the app is closed
      },
      app: {
        stopOnTerminate: false, startOnBoot: true, heartbeatInterval: 300,
        notification: { title: 'StartupTN HR', text: 'Work-hours location is on until check-out.', channelName: 'Work-hours location' },
        backgroundPermissionRationale: {
          title: 'Allow location all the time?',
          message: 'StartupTN HR records your work-hours location from check-in to check-out, also when the app is closed.',
          positiveAction: 'Allow all the time'
        }
      },
      http: {
        url: `${o.url}/functions/v1/check-in`, autoSync: true, batchSync: true, maxBatchSize: 50, rootProperty: 'samples',
        params: { action: 'presence' },
        headers: { apikey: o.anonKey, Authorization: `Bearer ${o.anonKey}`, 'x-presence-token': o.token }
      },
      persistence: { maxDaysToPersist: 3, disableProviderChangeRecord: false },
      logger: { debug: false, logLevel: BackgroundGeolocation.LogLevel.Off }
    });
    configured = key;
    // while the app is alive: a "still here" sample every 5 min when the phone is not moving
    beat?.remove();
    beat = BackgroundGeolocation.onHeartbeat(() => { void BackgroundGeolocation.getCurrentPosition({ samples: 1, persist: true, extras: { beat: true } }).catch(() => undefined); });
  }
  const st = await BackgroundGeolocation.getState();
  if (!st.enabled) await BackgroundGeolocation.start();
  return 'on';
}

export async function stopPresence() {
  if (!isStoreApp()) return;
  try {
    const st = await BackgroundGeolocation.getState();
    if (st.enabled) { await BackgroundGeolocation.sync().catch(() => undefined); await BackgroundGeolocation.stop(); }
  } catch { /* not configured yet */ }
}
