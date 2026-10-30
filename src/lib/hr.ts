// HR data layer. Real mode uses Supabase (RLS lets HR read everything); demo mode uses sample data.
import { sb, DEMO, ApiError } from './api';

export interface HrToday {
  staff: number; checked_in: number; late: number; od: number; leave: number;
  pending_leave: number; pending_od: number; open_flags: number; chairman_away: boolean;
}
export interface Person {
  id: string; full_name: string; email: string; role: string; hub: string | null; phone: string | null;
  employee_code: string | null; active: boolean; face_status: string;
  today?: { in_time: string | null; out_time: string | null; band: string | null; status: string } | null;
}
export interface LeaveReq { id: string; who: string; hub: string | null; leave_type: string; starts_on: string; ends_on: string; half_day: string | null; reason: string | null; status: string; created_at: string }
export interface OdReq { id: string; who: string; hub: string | null; subject: string; note: string | null; venue_name: string; starts_at: string; ends_at: string; status: string; created_at: string }
export interface Flag {
  id: string; kind: string; rule: string; details: Record<string, unknown>; status: string; staff_reason: string | null; created_at: string;
  user_id: string; who: string; hub: string | null;
  punch: { server_time: string; lat: number; lng: number; accuracy_m: number | null; place_name: string | null; distance_m: number | null;
    quality_score: number | null; face_similarity: number | null; selfie_key: string | null; mocked: boolean | null } | null;
}
export interface Hub { id: string; name: string; lat: number; lng: number; radius_m: number; maps_url: string | null; active: boolean; staff?: number }
export interface Pin { server_time: string; lat: number; lng: number; accuracy_m: number | null }

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const must = <T,>(r: { data: T | null; error: unknown }): T => { if (r.error) throw new ApiError('load_failed'); return r.data as T; };

// ---------------- real ----------------
const real = {
  async today(): Promise<HrToday> { return must(await sb!.rpc('hr_today')) as HrToday; },
  async people(): Promise<Person[]> {
    const ps = must(await sb!.from('profiles').select('id, full_name, email, role, phone, employee_code, active, face_status, hub:hubs(name)').in('role', ['staff', 'intern']).order('full_name'));
    const days = must(await sb!.from('attendance_days').select('user_id, in_time, out_time, band, status').eq('day', istToday()));
    const byUser = new Map((days as { user_id: string }[]).map((d) => [d.user_id, d]));
    return (ps as unknown as (Person & { hub: { name: string } | null })[]).map((p) => ({ ...p, hub: p.hub?.name ?? null, today: (byUser.get(p.id) as Person['today']) ?? null }));
  },
  async leaves(): Promise<LeaveReq[]> {
    const r = must(await sb!.from('leave_requests').select('id, leave_type, starts_on, ends_on, half_day, reason, status, created_at, p:profiles!leave_requests_user_id_fkey(full_name, hub:hubs(name))').eq('status', 'pending').order('starts_on'));
    return (r as unknown as (LeaveReq & { p: { full_name: string; hub: { name: string } | null } })[]).map((x) => ({ ...x, who: x.p.full_name, hub: x.p.hub?.name ?? null }));
  },
  async ods(): Promise<OdReq[]> {
    const r = must(await sb!.from('od_requests').select('id, subject, note, venue_name, starts_at, ends_at, status, created_at, p:profiles!od_requests_user_id_fkey(full_name, hub:hubs(name))').eq('status', 'pending').order('starts_at'));
    return (r as unknown as (OdReq & { p: { full_name: string; hub: { name: string } | null } })[]).map((x) => ({ ...x, who: x.p.full_name, hub: x.p.hub?.name ?? null }));
  },
  async flags(): Promise<Flag[]> {
    const r = must(await sb!.from('flags')
      .select('id, kind, rule, details, status, staff_reason, created_at, user_id, punch:punches(server_time, lat, lng, accuracy_m, place_name, distance_m, quality_score, face_similarity, selfie_key, mocked), p:profiles!flags_user_id_fkey(full_name, hub:hubs(name))')
      .in('status', ['open', 'reason_asked']).order('created_at', { ascending: false }).limit(100));
    return (r as unknown as (Flag & { p: { full_name: string; hub: { name: string } | null } })[])
      .filter((f) => f.kind !== 'late' || f.staff_reason)
      .map((f) => ({ ...f, who: f.p.full_name, hub: f.p.hub?.name ?? null }));
  },
  async pins(userId: string): Promise<Pin[]> {
    return must(await sb!.from('punches').select('server_time, lat, lng, accuracy_m').eq('user_id', userId).eq('kind', 'in').order('server_time', { ascending: false }).limit(7)) as Pin[];
  },
  async selfieUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    const { data } = await sb!.storage.from('selfies').createSignedUrl(key.replace(/^selfies\//, ''), 300);
    return data?.signedUrl ?? null;
  },
  async hubs(): Promise<Hub[]> {
    const hs = must(await sb!.from('hubs').select('id, name, lat, lng, radius_m, maps_url, active').order('name')) as Hub[];
    const ps = must(await sb!.from('profiles').select('hub_id').in('role', ['staff', 'intern']).eq('active', true)) as { hub_id: string | null }[];
    return hs.map((h) => ({ ...h, staff: ps.filter((p) => p.hub_id === h.id).length }));
  },
  async saveHub(h: Partial<Hub> & { name: string; lat: number; lng: number; radius_m: number }) {
    const q = h.id ? sb!.from('hubs').update({ name: h.name, lat: h.lat, lng: h.lng, radius_m: h.radius_m, maps_url: h.maps_url }).eq('id', h.id)
      : sb!.from('hubs').insert({ name: h.name, lat: h.lat, lng: h.lng, radius_m: h.radius_m, maps_url: h.maps_url });
    const { error } = await q; if (error) throw new ApiError('save_failed');
  },
  async addStaff(s: { full_name: string; email: string; role: 'staff' | 'intern'; hub_name: string; phone?: string; joined_on?: string; employee_code?: string }) {
    const { error } = await sb!.from('staff_roster').insert({ ...s, email: s.email.trim().toLowerCase(), employee_code: s.employee_code || null, phone: s.phone || null });
    if (error) throw new ApiError(error.code === '23505' ? 'already_added' : 'save_failed');
  },
  async setActive(id: string, active: boolean) { const { error } = await sb!.from('profiles').update({ active }).eq('id', id); if (error) throw new ApiError('save_failed'); },
  async decideLeave(id: string, decision: 'approved' | 'returned', reason?: string) { const { error } = await sb!.rpc('decide_leave', { p_id: id, p_decision: decision, p_reason: reason ?? null }); if (error) throw new ApiError(error.message); },
  async decideOd(id: string, decision: 'approved' | 'returned', reason?: string) { const { error } = await sb!.rpc('decide_od', { p_id: id, p_decision: decision, p_reason: reason ?? null }); if (error) throw new ApiError(error.message); },
  async longLeave(user: string, type: string, from: string, to: string) { const { error } = await sb!.rpc('assign_long_leave', { p_user: user, p_type: type, p_from: from, p_to: to }); if (error) throw new ApiError('save_failed'); },
  async askReason(id: string) { const { error } = await sb!.rpc('ask_flag_reason', { p_flag: id }); if (error) throw new ApiError('save_failed'); },
  async decideFlag(id: string, d: 'valid' | 'violation') { const { error } = await sb!.rpc('decide_flag', { p_flag: id, p_decision: d }); if (error) throw new ApiError('save_failed'); }
};

// ---------------- demo ----------------
const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
const D = {
  people: [
    { id: 'p1', full_name: 'Kavya R', email: 'kavya@startuptn.in', role: 'staff', hub: 'Chennai', phone: '98400 10001', employee_code: 'STN0142', active: true, face_status: 'approved', today: { in_time: iso(300), out_time: null, band: 'ok', status: 'present' } },
    { id: 'p2', full_name: 'Vignesh P', email: 'vignesh@startuptn.in', role: 'staff', hub: 'Trichy', phone: '98400 10002', employee_code: 'STN0117', active: true, face_status: 'approved', today: { in_time: iso(260), out_time: null, band: 'bad', status: 'present' } },
    { id: 'p3', full_name: 'Deepa V', email: 'deepa@startuptn.in', role: 'staff', hub: 'Villupuram', phone: '98400 10003', employee_code: 'STN0161', active: true, face_status: 'approved', today: { in_time: iso(295), out_time: null, band: 'ok', status: 'present' } },
    { id: 'p4', full_name: 'Imran A', email: 'imran@startuptn.in', role: 'staff', hub: 'Hosur', phone: '98400 10004', employee_code: 'STN0109', active: true, face_status: 'approved', today: { in_time: iso(268), out_time: null, band: 'bad', status: 'present' } },
    { id: 'p5', full_name: 'Sneha P', email: 'sneha.p@gmail.com', role: 'intern', hub: 'Erode', phone: null, employee_code: 'STNI021', active: true, face_status: 'pending', today: null }
  ] as Person[],
  leaves: [{ id: 'l1', who: 'Anitha R', hub: 'Salem', leave_type: 'casual', starts_on: '2026-11-12', ends_on: '2026-11-13', half_day: null, reason: 'Sister’s wedding', status: 'pending', created_at: iso(120) }] as LeaveReq[],
  ods: [{ id: 'o1', who: 'Gokul M', hub: 'Coimbatore', subject: 'Investor demo day', note: null, venue_name: 'Codissia, Coimbatore', starts_at: iso(-180), ends_at: iso(-360), status: 'pending', created_at: iso(60) }] as OdReq[],
  flags: [
    { id: 'f1', kind: 'location_changer', rule: 'R-04 same point 5+ days, spread < 1 m', details: { spread_m: 0 }, status: 'open', staff_reason: null, created_at: iso(290), user_id: 'p3', who: 'Deepa V', hub: 'Villupuram',
      punch: { server_time: iso(295), lat: 11.93941, lng: 79.48623, accuracy_m: 5, place_name: 'Villupuram', distance_m: 40, quality_score: 18, face_similarity: 95, selfie_key: null, mocked: null } },
    { id: 'f2', kind: 'radius', rule: 'R-02 distance > 500 m', details: { distance_m: 1400, accuracy_m: 14 }, status: 'open', staff_reason: null, created_at: iso(260), user_id: 'p2', who: 'Vignesh P', hub: 'Trichy',
      punch: { server_time: iso(260), lat: 10.8064, lng: 78.6851, accuracy_m: 14, place_name: 'Cantonment, Trichy', distance_m: 1400, quality_score: 86, face_similarity: 93, selfie_key: null, mocked: null } },
    { id: 'f3', kind: 'late', rule: 'R-01 check-in after 10:15', details: {}, status: 'reason_asked', staff_reason: 'Bus broke down on Hosur road.', created_at: iso(268), user_id: 'p4', who: 'Imran A', hub: 'Hosur',
      punch: { server_time: iso(268), lat: 12.7409, lng: 77.8253, accuracy_m: 9, place_name: 'Bagalur Road, Hosur', distance_m: 40, quality_score: 91, face_similarity: 97, selfie_key: null, mocked: null } }
  ] as Flag[],
  hubs: ['Chennai', 'Coimbatore', 'Madurai', 'Salem', 'Trichy', 'Erode', 'Hosur', 'Tirunelveli', 'Thoothukudi', 'Villupuram']
    .map((n, i) => ({ id: `h${i}`, name: n, lat: 11 + i * 0.1, lng: 78 + i * 0.1, radius_m: 500, maps_url: null, active: true, staff: [28, 12, 11, 8, 8, 7, 7, 6, 5, 4][i] })) as Hub[]
};
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const demo: typeof real = {
  async today() { await wait(); return { staff: 96, checked_in: 77, late: 6, od: 6, leave: 4, pending_leave: D.leaves.length, pending_od: D.ods.length, open_flags: D.flags.length, chairman_away: false }; },
  async people() { await wait(); return D.people; },
  async leaves() { await wait(); return D.leaves; },
  async ods() { await wait(); return D.ods; },
  async flags() { await wait(); return D.flags; },
  async pins(uid) {
    await wait();
    const same = uid === 'p3';
    return Array.from({ length: 7 }, (_, i) => ({ server_time: iso(295 + i * 1440), lat: same ? 11.93941 : 11.9394 + (i % 3) * 0.00011, lng: same ? 79.48623 : 79.4862 + (i % 2) * 0.00009, accuracy_m: same ? 5 : 9 + i * 3 }));
  },
  async selfieUrl() { return null; },
  async hubs() { await wait(); return D.hubs; },
  async saveHub(h) { await wait(); const i = D.hubs.findIndex((x) => x.id === h.id); if (i >= 0) D.hubs[i] = { ...D.hubs[i], ...h }; else D.hubs.push({ ...h, id: crypto.randomUUID(), active: true, maps_url: h.maps_url ?? null, staff: 0 }); },
  async addStaff(s) { await wait(); D.people.push({ id: crypto.randomUUID(), full_name: s.full_name, email: s.email, role: s.role, hub: s.hub_name, phone: s.phone ?? null, employee_code: s.employee_code ?? null, active: true, face_status: 'none', today: null }); },
  async setActive(id, active) { await wait(); const p = D.people.find((x) => x.id === id); if (p) p.active = active; },
  async decideLeave(id) { await wait(); D.leaves = D.leaves.filter((x) => x.id !== id); },
  async decideOd(id) { await wait(); D.ods = D.ods.filter((x) => x.id !== id); },
  async longLeave() { await wait(); },
  async askReason(id) { await wait(); const f = D.flags.find((x) => x.id === id); if (f) f.status = 'reason_asked'; },
  async decideFlag(id) { await wait(); D.flags = D.flags.filter((x) => x.id !== id); }
};

export const hr = DEMO ? demo : real;

export const FLAG_LABEL: Record<string, [string, string]> = {
  location_changer: ['Location changer', 'c-bad'], mock_location: ['Mock location', 'c-bad'], radius: ['Outside radius', 'c-bad'],
  face: ['Face mismatch', 'c-bad'], liveness: ['Liveness', 'c-warn'], device: ['Device', 'c-bad'], jump: ['Impossible jump', 'c-bad'],
  clock: ['Phone clock', 'c-warn'], offline: ['Synced late', 'c-warn'], late: ['Late', 'c-warn'], early_out: ['Early out', 'c-warn']
};
