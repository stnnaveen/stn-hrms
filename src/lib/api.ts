// One API surface for the screens. Real mode talks to Supabase; demo mode (no env set) uses sample data
// so the app can be clicked through before the backend exists.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { enqueue, pending, remove, type QueuedPunch } from '../device/queue';
import { deviceKey, platform } from '../device';

export interface Today {
  profile: { full_name: string; employee_code: string | null; role: string; hub: string | null; face_status: string; consented: boolean };
  today: { in_time: string | null; out_time: string | null; band: 'ok' | 'warn' | 'bad' | null; early_out: boolean; status: string } | null;
  month: { on_time: number; late: number; early: number };
  requests: { type: 'od' | 'leave'; id: string; title: string; starts: string; status: string }[];
  /** Today's approved OD, if any. visited_at = venue check-in time (never whether it matched). */
  test_mode?: boolean;
  ods_today?: { id: string; subject: string; venue_name: string; starts_at: string; ends_at: string; status: string }[];
  chairman_available?: { starts_at: string; ends_at: string; place: string | null; note: string | null }[];
  od_today?: { id: string; subject: string; venue_name: string; venue_place: string | null; venue_url: string | null; starts_at: string; ends_at: string; visited_at: string | null } | null;
}
export interface Venue { lat: number; lng: number; name: string | null; place: string | null; url: string }
export interface PunchResult {
  kind: 'in' | 'out' | 'visit'; server_time: string; band: 'ok' | 'warn' | 'bad' | null; early_out: boolean;
  place_name: string | null; lat: number; lng: number; queued?: boolean;
}
export interface Notif { id: string; kind: string; title: string; body: string | null; created_at: string; read_at: string | null; data?: { flag_id?: string } }
export interface ODInput { subject: string; note?: string; venue_name: string; venue_lat: number; venue_lng: number; venue_url: string; venue_place: string | null; starts_at: string; ends_at: string }
export interface LeaveInput { leave_type: string; starts_on: string; ends_on: string; half_day?: 'first' | 'second' | null; reason?: string }

export class ApiError extends Error { constructor(public code: string) { super(code); } }

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const sb: SupabaseClient | null = URL && KEY ? createClient(URL, KEY, { auth: { persistSession: true, detectSessionInUrl: true } }) : null;
export const DEMO = !sb;

type PunchInput = Omit<QueuedPunch, 'idempotency_key' | 'client_time'> & { idempotency_key?: string; client_time?: string };

// ---------------- real ----------------
async function invoke<T>(body: Record<string, unknown> | FormData): Promise<T> {
  const { data, error } = await sb!.functions.invoke('check-in', { body });
  if (error) {
    let code = 'network';
    try { code = (await (error as { context?: Response }).context?.json())?.error ?? code; } catch { /* keep */ }
    throw new ApiError(code);
  }
  return data as T;
}

// Codes that mean "this check-in will never be accepted" (drop it from the phone's queue) vs "try again later" (keep it).
const FINAL_REFUSALS = new Set(['already_checked_in', 'already_checked_out', 'not_checked_in', 'check_in_first', 'no_od_now', 'already_visited', 'bad_selfie', 'bad_location', 'bad_time', 'bad_request', 'bad_selfie_key', 'not_active', 'device_revoked']);
const RETRYABLE = new Set(['network', 'upload_failed', 'save_failed', 'not_signed_in', 'upload_unavailable']);
const SAVE_TIMEOUT_MS = 40000;   // after this the phone keeps the check-in and sends it later; staff are never stuck
const withTimeout = <T,>(pr: Promise<T>, ms: number) => Promise.race([pr, new Promise<T>((_, rej) => setTimeout(() => rej(new ApiError('network')), ms))]);

/** One request: selfie + details together (no separate upload step), then report how long it took. */
async function sendPunch(p: QueuedPunch): Promise<PunchResult> {
  const device_key = await deviceKey();
  const t0 = performance.now();
  const fd = new FormData();
  fd.append('data', JSON.stringify({ kind: p.kind, idempotency_key: p.idempotency_key, device_key, platform, client_time: p.client_time, location: p.location, liveness: p.liveness, timings: p.timings ?? {}, leave_for_od: p.leave_for_od ?? null }));
  fd.append('selfie', p.selfie, 'selfie.jpg');
  const res = await withTimeout(invoke<PunchResult>(fd as unknown as Record<string, unknown>), SAVE_TIMEOUT_MS);
  const total = Math.round((p.timings?.before_send_ms ?? 0) + (performance.now() - t0));
  void invoke({ action: 'timing', idempotency_key: p.idempotency_key, total_ms: total }).catch(() => undefined);
  return res;
}

/** Older two-step path (signed upload, then complete); kept for check-ins queued by an earlier app version. */
export async function sendPunchTwoStep(p: QueuedPunch): Promise<PunchResult> {
  const device_key = await deviceKey();
  const base = { kind: p.kind, idempotency_key: p.idempotency_key, device_key, platform };
  const start = await invoke<{ store: 's3' | 'supabase'; upload_url?: string; upload_path?: string; upload_token?: string; selfie_key: string }>({ action: 'start', ...base });
  if (start.store === 'supabase') {
    const { error } = await sb!.storage.from('selfies').uploadToSignedUrl(start.upload_path!, start.upload_token!, p.selfie, { contentType: 'image/jpeg' });
    if (error) throw new ApiError('upload_failed');
  } else {
    const put = await fetch(start.upload_url!, { method: 'PUT', body: p.selfie, headers: { 'Content-Type': 'image/jpeg' } });
    if (!put.ok) throw new ApiError('upload_failed');
  }
  return invoke<PunchResult>({ action: 'complete', ...base, selfie_key: start.selfie_key, client_time: p.client_time, location: p.location, liveness: p.liveness });
}

const real = {
  async session() { const { data } = await sb!.auth.getSession(); return data.session ? { email: data.session.user.email ?? '' } : null; },
  onAuth(cb: (signedIn: boolean) => void) { const { data } = sb!.auth.onAuthStateChange((_e, s) => cb(!!s)); return () => data.subscription.unsubscribe(); },
  async sendCode(email: string) {
    // First sign-in creates the account; the database refuses any email not on HR's staff roster.
    const { error } = await sb!.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin } });
    if (error) {
      console.warn('sign-in email failed:', error.status, error.message);
      throw new ApiError(/database error|not_on_roster|signups|not.*found/i.test(error.message) ? 'unknown_email'
        : error.status === 429 || /rate limit/i.test(error.message) ? 'too_many'
        : /sending|smtp|email/i.test(error.message) ? 'email_failed' : 'send_failed');
    }
  },
  async verifyCode(email: string, token: string) {
    const { error } = await sb!.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw new ApiError('bad_code');
  },
  async google() { await sb!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } }); },
  async signOut() { await sb!.auth.signOut(); },
  async today(): Promise<Today> { const { data, error } = await sb!.rpc('my_today'); if (error) throw new ApiError('load_failed'); return data as Today; },
  async consent() { const { error } = await sb!.rpc('give_consent'); if (error) throw new ApiError('save_failed'); },
  /** Test staff: clear today's check-ins to try again. */
  async resetTestDay() { await invoke({ action: 'reset_test_day' }); },
  /** Wake the server when the camera opens, so the save itself is quick. */
  warm() { void invoke({ action: 'ping' }).catch(() => undefined); },
  async punch(input: PunchInput): Promise<PunchResult> {
    const p: QueuedPunch = { ...input, idempotency_key: input.idempotency_key ?? crypto.randomUUID(), client_time: input.client_time ?? new Date().toISOString() };
    if (!navigator.onLine) { await enqueue(p); return offlineResult(p); }
    try { return await sendPunch(p); }
    catch (e) {
      if (e instanceof ApiError && FINAL_REFUSALS.has(e.code)) throw e;   // e.g. already checked in: tell the person
      if (e instanceof ApiError && !RETRYABLE.has(e.code)) throw e;
      await enqueue(p); return offlineResult(p);
    }
  },
  async flushQueue(): Promise<number> {
    let sent = 0;
    for (const p of await pending()) {
      try { await sendPunch(p); await remove(p.idempotency_key); sent++; }
      catch (e) {
        // keep it and try later unless the server clearly refused this check-in for good
        if (e instanceof ApiError && FINAL_REFUSALS.has(e.code)) await remove(p.idempotency_key); else break;
      }
    }
    return sent;
  },
  async notifications(): Promise<Notif[]> {
    const { data } = await sb!.from('notifications').select('id, kind, title, body, created_at, read_at, data').order('created_at', { ascending: false }).limit(50);
    return (data ?? []) as Notif[];
  },
  async markAllRead() { await sb!.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null); },
  async submitReason(flagId: string, reason: string) { const { error } = await sb!.rpc('submit_flag_reason', { p_flag: flagId, p_reason: reason }); if (error) throw new ApiError('save_failed'); },
  /** Google / Apple Maps link -> pin, name and place, read on the server. */
  async resolveVenue(url: string): Promise<Venue> { return invoke<Venue>({ action: 'resolve_venue', url }); },
  async createOD(od: ODInput) {
    const { data: u } = await sb!.auth.getUser();
    const { error } = await sb!.from('od_requests').insert({ ...od, user_id: u.user!.id });
    if (error) throw new ApiError(/venue_/.test(error.message) ? 'venue_pin_needed' : 'save_failed');
  },
  async createLeave(lv: LeaveInput) {
    const { data: u } = await sb!.auth.getUser();
    const { error } = await sb!.from('leave_requests').insert({ ...lv, user_id: u.user!.id });
    if (error) throw new ApiError('save_failed');
  }
};

function offlineResult(p: QueuedPunch): PunchResult {
  return { kind: p.kind, server_time: p.client_time, band: null, early_out: false, place_name: null, lat: p.location.lat, lng: p.location.lng, queued: true };
}

// ---------------- demo ----------------
const demoState = {
  signedIn: false, consented: false, email: 'kavya@startuptn.in',
  today: null as Today['today'],
  odToday: { id: 'od-today', subject: 'Collector review', venue_name: 'Collectorate', venue_place: 'Collectorate, Chennai', venue_url: 'https://maps.app.goo.gl/demo', starts_at: new Date(Date.now() - 36e5).toISOString(), ends_at: new Date(Date.now() + 3 * 36e5).toISOString(), visited_at: null } as NonNullable<Today['od_today']>,
  requests: [{ type: 'od', id: 'd1', title: 'TIDCO policy meet', starts: '2026-11-03', status: 'approved' }] as Today['requests'],
  notifs: [
    { id: 'n1', kind: 'od_approved', title: 'OD approved', body: 'TIDCO policy meet', created_at: new Date(Date.now() - 36e5).toISOString(), read_at: null },
    { id: 'n3', kind: 'reason_asked', title: 'Add a reason', body: 'For your check-in on 30 Oct, 10:24 AM', created_at: new Date(Date.now() - 6e5).toISOString(), read_at: null, data: { flag_id: 'f3' } },
    { id: 'n2', kind: 'info', title: 'Welcome to StartupTN HR', body: 'Check in by 10:00 AM.', created_at: new Date(Date.now() - 864e5).toISOString(), read_at: new Date().toISOString() }
  ] as Notif[]
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listeners = new Set<(b: boolean) => void>();

const demo = {
  async session() { return demoState.signedIn ? { email: demoState.email } : null; },
  onAuth(cb: (b: boolean) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  async sendCode(email: string) { await wait(400); if (!/@/.test(email)) throw new ApiError('unknown_email'); demoState.email = email.toLowerCase(); },
  async verifyCode(_e: string, code: string) { await wait(400); if (code.length < 6) throw new ApiError('bad_code'); demoState.signedIn = true; listeners.forEach((l) => l(true)); },
  async google() { demoState.signedIn = true; listeners.forEach((l) => l(true)); },
  async signOut() { demoState.signedIn = false; listeners.forEach((l) => l(false)); },
  async today(): Promise<Today> {
    await wait(150);
    return {
      profile: demoState.email.startsWith('hr@') ? { full_name: 'HR team', employee_code: null, role: 'hr', hub: null, face_status: 'none', consented: true }
        : demoState.email.startsWith('chairman') ? { full_name: 'Chairman', employee_code: null, role: 'chairman', hub: null, face_status: 'none', consented: true }
        : demoState.email.startsWith('ai@') ? { full_name: 'Tech admin', employee_code: null, role: 'tech', hub: null, face_status: 'none', consented: true }
        : { full_name: 'Kavya R', employee_code: 'STN0142', role: 'staff', hub: 'Chennai', face_status: 'approved', consented: demoState.consented },
      today: demoState.today, month: { on_time: 18, late: 2, early: 1 }, requests: demoState.requests, od_today: demoState.odToday,
      test_mode: true, ods_today: demoState.odToday ? [{ id: demoState.odToday.id, subject: demoState.odToday.subject, venue_name: demoState.odToday.venue_name, starts_at: demoState.odToday.starts_at, ends_at: demoState.odToday.ends_at, status: 'approved' }] : [],
      chairman_available: [{ starts_at: new Date(Date.now() + 36e5).toISOString(), ends_at: new Date(Date.now() + 3 * 36e5).toISOString(), place: 'Chennai hub', note: 'Walk in for quick reviews' }]
    };
  },
  async consent() { await wait(200); demoState.consented = true; },
  warm() { /* demo */ },
  async resetTestDay() { await wait(300); demoState.today = null; if (demoState.odToday) demoState.odToday.visited_at = null; },
  async punch(p: PunchInput): Promise<PunchResult> {
    await wait(900);
    const now = new Date();
    const m = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
    const band = p.kind === 'in' ? (m <= 600 ? 'ok' : m <= 615 ? 'warn' : 'bad') : null;
    if (p.kind === 'visit') { if (demoState.odToday) demoState.odToday.visited_at = now.toISOString(); }
    else if (p.kind === 'in') demoState.today = { in_time: now.toISOString(), out_time: null, band, early_out: false, status: 'present' };
    else if (demoState.today) demoState.today = { ...demoState.today, out_time: now.toISOString(), early_out: m < 1080 && !p.leave_for_od };
    return { kind: p.kind, server_time: now.toISOString(), band, early_out: p.kind === 'out' && m < 1080 && !p.leave_for_od, place_name: 'Guindy, Chennai', lat: p.location.lat, lng: p.location.lng };
  },
  async flushQueue() { return 0; },
  async notifications() { return demoState.notifs; },
  async markAllRead() { demoState.notifs.forEach((n) => (n.read_at = n.read_at ?? new Date().toISOString())); },
  async submitReason(_f: string, _r: string) { await wait(300); },
  async resolveVenue(url: string): Promise<Venue> {
    await wait(700);
    if (!/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z.]+|maps\.apple\.com|maps\.apple)\//i.test(url.trim().match(/https?:\/\/\S+/)?.[0] ?? '')) throw new ApiError('not_maps_link');
    const m = url.match(/(-?\d+\.\d+),(-?\d+\.\d+)/);
    return m ? { lat: +m[1], lng: +m[2], name: decodeURIComponent(url.match(/place\/([^/@]+)/)?.[1]?.replace(/\+/g, ' ') ?? '') || null, place: 'Guindy, Chennai', url }
      : { lat: 13.0109, lng: 80.2117, name: 'TIDCO Office', place: 'Mount Road, Guindy, Chennai', url };
  },
  async createOD(od: ODInput) { await wait(300); demoState.requests.unshift({ type: 'od', id: crypto.randomUUID(), title: od.subject, starts: od.starts_at, status: 'pending' }); },
  async createLeave(lv: LeaveInput) { await wait(300); demoState.requests.unshift({ type: 'leave', id: crypto.randomUUID(), title: `${lv.leave_type[0].toUpperCase()}${lv.leave_type.slice(1)} leave`, starts: lv.starts_on, status: 'pending' }); }
};

export const api = DEMO ? demo : real;

/** Staff-facing words for server error codes. Never mentions radius or checks. */
export function errorText(code: string): string {
  return ({
    unknown_email: 'This email is not set up yet. Ask HR.',
    bad_code: 'That code did not work. Try again.',
    send_failed: 'Could not send the code. Try again.',
    too_many: 'Too many tries. Wait a minute.',
    email_failed: 'Email couldn’t be sent. Check email settings.',
    device_pending: 'New phone. Waiting for approval.',
    device_revoked: 'This phone is blocked. Contact HR.',
    consent_needed: 'Please accept the consent first.',
    already_checked_in: 'You are already checked in.',
    not_checked_in: 'Check in first.',
    already_checked_out: 'You are already checked out.',
    no_hub: 'No hub set for you yet. Ask HR.',
    check_in_first: 'Check in for the day first.',
    no_od_now: 'Your OD time hasn’t started yet.',
    already_visited: 'Venue check-in already done.',
    not_maps_link: 'Paste a Google Maps or Apple Maps link.',
    no_pin: 'Couldn’t find the place in this link. Copy it again from Maps.',
    venue_pin_needed: 'Paste the venue’s map link.',
    bad_location: 'Could not read your location. Try again.',
    bad_time: 'Your phone’s date looks wrong. Fix it and try again.',
    bad_selfie: 'The photo didn’t come through. Try again.',
    location_denied: 'Turn on location to check in.',
    no_fix: 'Could not find your location. Step outside and retry.',
    no_camera: 'Camera not available on this browser.',
    camera_denied: 'Allow the camera to check in.',
    save_failed: 'Could not save. Try again.',
    load_failed: 'Could not load. Pull to retry.'
  } as Record<string, string>)[code] ?? 'Something went wrong. Try again.';
}
