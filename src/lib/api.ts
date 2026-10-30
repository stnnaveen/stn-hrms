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
}
export interface PunchResult {
  kind: 'in' | 'out'; server_time: string; band: 'ok' | 'warn' | 'bad' | null; early_out: boolean;
  place_name: string | null; lat: number; lng: number; queued?: boolean;
}
export interface Notif { id: string; kind: string; title: string; body: string | null; created_at: string; read_at: string | null }
export interface ODInput { subject: string; note?: string; venue_name: string; venue_lat: number | null; venue_lng: number | null; starts_at: string; ends_at: string }
export interface LeaveInput { leave_type: string; starts_on: string; ends_on: string; half_day?: 'first' | 'second' | null; reason?: string }

export class ApiError extends Error { constructor(public code: string) { super(code); } }

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const sb: SupabaseClient | null = URL && KEY ? createClient(URL, KEY, { auth: { persistSession: true, detectSessionInUrl: true } }) : null;
export const DEMO = !sb;

type PunchInput = Omit<QueuedPunch, 'idempotency_key' | 'client_time'> & { idempotency_key?: string; client_time?: string };

// ---------------- real ----------------
async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb!.functions.invoke('check-in', { body });
  if (error) {
    let code = 'network';
    try { code = (await (error as { context?: Response }).context?.json())?.error ?? code; } catch { /* keep */ }
    throw new ApiError(code);
  }
  return data as T;
}

async function sendPunch(p: QueuedPunch): Promise<PunchResult> {
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
    if (error) throw new ApiError(/database error|not_on_roster|signups|not.*found/i.test(error.message) ? 'unknown_email' : error.status === 429 ? 'too_many' : 'send_failed');
  },
  async verifyCode(email: string, token: string) {
    const { error } = await sb!.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw new ApiError('bad_code');
  },
  async google() { await sb!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } }); },
  async signOut() { await sb!.auth.signOut(); },
  async today(): Promise<Today> { const { data, error } = await sb!.rpc('my_today'); if (error) throw new ApiError('load_failed'); return data as Today; },
  async consent() { const { error } = await sb!.rpc('give_consent'); if (error) throw new ApiError('save_failed'); },
  async punch(input: PunchInput): Promise<PunchResult> {
    const p: QueuedPunch = { ...input, idempotency_key: input.idempotency_key ?? crypto.randomUUID(), client_time: input.client_time ?? new Date().toISOString() };
    if (!navigator.onLine) { await enqueue(p); return offlineResult(p); }
    try { return await sendPunch(p); }
    catch (e) {
      if (e instanceof ApiError && e.code !== 'network' && e.code !== 'upload_failed') throw e;
      await enqueue(p); return offlineResult(p);
    }
  },
  async flushQueue(): Promise<number> {
    let sent = 0;
    for (const p of await pending()) {
      try { await sendPunch(p); await remove(p.idempotency_key); sent++; }
      catch (e) { if (e instanceof ApiError && e.code !== 'network' && e.code !== 'upload_failed') await remove(p.idempotency_key); else break; }
    }
    return sent;
  },
  async notifications(): Promise<Notif[]> {
    const { data } = await sb!.from('notifications').select('id, kind, title, body, created_at, read_at').order('created_at', { ascending: false }).limit(50);
    return (data ?? []) as Notif[];
  },
  async markAllRead() { await sb!.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null); },
  async createOD(od: ODInput) {
    const { data: u } = await sb!.auth.getUser();
    const { error } = await sb!.from('od_requests').insert({ ...od, user_id: u.user!.id });
    if (error) throw new ApiError('save_failed');
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
  signedIn: false, consented: false,
  today: null as Today['today'],
  requests: [{ type: 'od', id: 'd1', title: 'TIDCO policy meet', starts: '2026-11-03', status: 'approved' }] as Today['requests'],
  notifs: [
    { id: 'n1', kind: 'od_approved', title: 'OD approved', body: 'TIDCO policy meet', created_at: new Date(Date.now() - 36e5).toISOString(), read_at: null },
    { id: 'n2', kind: 'info', title: 'Welcome to StartupTN HR', body: 'Check in by 10:00 AM.', created_at: new Date(Date.now() - 864e5).toISOString(), read_at: new Date().toISOString() }
  ] as Notif[]
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listeners = new Set<(b: boolean) => void>();

const demo = {
  async session() { return demoState.signedIn ? { email: 'kavya@startuptn.in' } : null; },
  onAuth(cb: (b: boolean) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  async sendCode(email: string) { await wait(400); if (!/@/.test(email)) throw new ApiError('unknown_email'); },
  async verifyCode(_e: string, code: string) { await wait(400); if (code.length !== 6) throw new ApiError('bad_code'); demoState.signedIn = true; listeners.forEach((l) => l(true)); },
  async google() { demoState.signedIn = true; listeners.forEach((l) => l(true)); },
  async signOut() { demoState.signedIn = false; listeners.forEach((l) => l(false)); },
  async today(): Promise<Today> {
    await wait(150);
    return {
      profile: { full_name: 'Kavya R', employee_code: 'STN0142', role: 'staff', hub: 'Chennai', face_status: 'approved', consented: demoState.consented },
      today: demoState.today, month: { on_time: 18, late: 2, early: 1 }, requests: demoState.requests
    };
  },
  async consent() { await wait(200); demoState.consented = true; },
  async punch(p: PunchInput): Promise<PunchResult> {
    await wait(900);
    const now = new Date();
    const m = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
    const band = p.kind === 'in' ? (m <= 600 ? 'ok' : m <= 615 ? 'warn' : 'bad') : null;
    if (p.kind === 'in') demoState.today = { in_time: now.toISOString(), out_time: null, band, early_out: false, status: 'present' };
    else if (demoState.today) demoState.today = { ...demoState.today, out_time: now.toISOString(), early_out: m < 1080 };
    return { kind: p.kind, server_time: now.toISOString(), band, early_out: p.kind === 'out' && m < 1080, place_name: 'Guindy, Chennai', lat: p.location.lat, lng: p.location.lng };
  },
  async flushQueue() { return 0; },
  async notifications() { return demoState.notifs; },
  async markAllRead() { demoState.notifs.forEach((n) => (n.read_at = n.read_at ?? new Date().toISOString())); },
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
    device_pending: 'New phone. Waiting for approval.',
    device_revoked: 'This phone is blocked. Contact HR.',
    consent_needed: 'Please accept the consent first.',
    already_checked_in: 'You are already checked in.',
    not_checked_in: 'Check in first.',
    already_checked_out: 'You are already checked out.',
    no_hub: 'No hub set for you yet. Ask HR.',
    location_denied: 'Turn on location to check in.',
    no_fix: 'Could not find your location. Step outside and retry.',
    no_camera: 'Camera not available on this browser.',
    camera_denied: 'Allow the camera to check in.',
    save_failed: 'Could not save. Try again.',
    load_failed: 'Could not load. Pull to retry.'
  } as Record<string, string>)[code] ?? 'Something went wrong. Try again.';
}
