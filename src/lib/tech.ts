// Tech admin data layer (PRD TA-01..TA-09). Tech reads everything (RLS), and changes roles, rules and phones
// only through Tech-only RPCs. Health comes from the check-in function and names services, never keys.
import { sb, DEMO, ApiError } from './api';
import type { Flag } from './hr';

export interface Health { db_ok: boolean; db_ms: number; storage: 's3' | 'supabase'; face_match: boolean; geocode: 'google' | 'ola' | 'osm'; region: string }
export interface Overview {
  staff: number; checkins: number; openAlerts: number; quality: number | null;
  newPhones: number; flaggedPhones: number; falseFlags: number;
  selfies24: number; facePass: number | null; gpsMedian: number | null;
}
export interface AuditRow { id: number; at: string; actor: string; who?: string | null; actorRole: string; action: string; entity: string; entityId: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; hash: string; prev: string | null }
export interface RoleLogin { email: string; name: string; role: 'hr' | 'chairman' | 'tech'; signedIn: boolean; active: boolean; temp: boolean }
export interface TestStaff { email: string; name: string; hub: string | null; signedIn: boolean }
export interface Roles { logins: RoleLogin[]; staff: number; interns: number; tests?: TestStaff[] }
export interface Device { id: string; userId: string; who: string; hub: string | null; platform: string; ua: string | null; status: 'active' | 'pending' | 'revoked'; created_at: string; approved_at: string | null }
export interface Devices { pending: Device[]; active: Device[]; flagged: { userId: string; who: string; hub: string | null; kind: string; at: string }[] }
export interface Accuracy {
  n: number; gpsMedian: number | null; gpsP95: number | null; within50: number | null; spread: { l: string; n: number }[];
  faceN: number; facePass: number | null; faceAvg: number | null; faceSpread: { l: string; n: number }[];
  rules: { kind: string; raised: number; valid: number; violation: number; falseFlags: number }[];
  falseList: { id: string; who: string; kind: string; at: string }[];
}
export type Settings = Record<string, string | number>;
export interface RadiusResult { distance_m: number; credit_m: number; inside: boolean; radius_m: number; place: string | null }
export interface HubPunch { lat: number; lng: number; acc: number | null; inside: boolean | null; at: string; who: string; kind: string }
export interface SelfieStats { total: number; people: { id: string; name: string; hub: string | null; count: number; last: string }[] }
export interface SelfieRow { id: string; kind: string; at: string; place: string | null; key: string }
export interface SpeedRow { who: string; at: string; kind: string; total: number | null; gps: number | null; upload: number | null; server: number | null; oneShot: boolean }
export interface Speed { n: number; median: number | null; p95: number | null; over60: number; slowest: SpeedRow[] }
export type PurgeWhat = 'checkins' | 'flags' | 'od' | 'leave' | 'notifications' | 'devices';
export interface PurgeArgs { scope: 'person' | 'hub' | 'test' | 'everyone'; user?: string | null; hub?: string | null; from?: string | null; to?: string | null; what: PurgeWhat[]; dry: boolean }
export interface PurgeResult { people: number; checkins: number; days: number; flags: number; od: number; leave: number; notifications: number; devices: number; photos_removed?: number }
export const TEMP_LOGINS = ['naveenflop@gmail.com', 'naveenbackup7@gmail.com'];

const must = <T,>(r: { data: T | null; error: unknown }): T => { if (r.error) throw new ApiError('load_failed'); return r.data as T; };
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const bucket = (a: number[], edges: number[], unit: string) => edges.map((e, i) => ({ l: i === 0 ? `≤ ${e} ${unit}` : i === edges.length - 1 ? `> ${edges[i - 1]} ${unit}` : `${edges[i - 1]}–${e} ${unit}`, n: a.filter((v) => (i === 0 ? v <= e : i === edges.length - 1 ? v > edges[i - 1] : v > edges[i - 1] && v <= e)).length }));
const rpcErr = (e: { message?: string } | null) => { if (e) throw new ApiError((e.message ?? 'save_failed').replace(/^.*?:\s*/, '')); };
type PN = { full_name: string; hub: { name: string } | null } | null;

// ---------------- real ----------------
const real = {
  async health(): Promise<Health> {
    const { data, error } = await sb!.functions.invoke('check-in', { body: { action: 'health' } });
    if (error || !data?.ok) throw new ApiError('health_failed');
    return data as Health;
  },
  async overview(): Promise<Overview> {
    const today = istToday(), since24 = new Date(Date.now() - 864e5).toISOString(), since30 = new Date(Date.now() - 30 * 864e5).toISOString();
    const [staff, days, open, q, dev, flg, ff, pu, thr] = await Promise.all([
      sb!.from('profiles').select('id', { count: 'exact', head: true }).in('role', ['staff', 'intern']).eq('active', true),
      sb!.from('attendance_days').select('user_id', { count: 'exact', head: true }).eq('day', today).not('in_time', 'is', null),
      sb!.from('flags').select('id', { count: 'exact', head: true }).in('status', ['open', 'reason_asked']).neq('kind', 'late'),
      sb!.from('punches').select('quality_score').gte('server_time', new Date(Date.now() - 7 * 864e5).toISOString()).not('quality_score', 'is', null).limit(2000),
      sb!.from('devices').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      sb!.from('flags').select('user_id').in('kind', ['mock_location', 'device']).gte('created_at', since30),
      sb!.from('flags').select('id', { count: 'exact', head: true }).not('details->>false_flag_at', 'is', null).gte('created_at', since30),
      sb!.from('punches').select('accuracy_m, face_similarity, selfie_key').gte('server_time', since24).limit(2000),
      sb!.from('settings').select('value').eq('key', 'face_threshold').maybeSingle()
    ]);
    const qs = (must(q) as { quality_score: number }[]).map((x) => x.quality_score);
    const p24 = must(pu) as { accuracy_m: number | null; face_similarity: number | null; selfie_key: string | null }[];
    const faces = p24.map((p) => p.face_similarity).filter((x): x is number => x != null), t = Number(thr.data?.value ?? 80);
    return {
      staff: staff.count ?? 0, checkins: days.count ?? 0, openAlerts: open.count ?? 0, quality: qs.length ? Math.round(qs.reduce((a, b) => a + b, 0) / qs.length) : null,
      newPhones: dev.count ?? 0, flaggedPhones: new Set((must(flg) as { user_id: string }[]).map((f) => f.user_id)).size, falseFlags: ff.count ?? 0,
      selfies24: p24.filter((p) => p.selfie_key).length, facePass: faces.length ? Math.round((faces.filter((f) => f >= t).length / faces.length) * 1000) / 10 : null,
      gpsMedian: median(p24.map((p) => p.accuracy_m).filter((x): x is number => x != null))
    };
  },
  async audit(): Promise<AuditRow[]> {
    const rows = must(await sb!.from('audit_log').select('id, actor_id, actor_role, action, entity, entity_id, before, after, hash, prev_hash, created_at').order('id', { ascending: false }).limit(300)) as
      { id: number; actor_id: string | null; actor_role: string | null; action: string; entity: string; entity_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; hash: string; prev_hash: string | null; created_at: string }[];
    const names = new Map<string, string>();
    for (const p of must(await sb!.from('profiles').select('id, full_name')) as { id: string; full_name: string }[]) names.set(p.id, p.full_name);
    const subj = (r: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) => { const u = (r.after?.user_id ?? r.before?.user_id) as string | undefined; return u ? names.get(u) ?? null : null; };
    return rows.map((r) => ({ id: r.id, at: r.created_at, who: subj(r), actor: r.actor_id ? names.get(r.actor_id) ?? 'Unknown' : 'System', actorRole: r.actor_role ?? 'system', action: r.action, entity: r.entity, entityId: r.entity_id, before: r.before, after: r.after, hash: r.hash, prev: r.prev_hash }));
  },
  async verifyChain(): Promise<{ ok: boolean; rows: number; broken_at?: number }> { const { data, error } = await sb!.rpc('verify_audit_chain'); rpcErr(error); return data; },
  async alerts(): Promise<Flag[]> {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = must(await sb!.from('flags')
      .select('id, kind, rule, details, status, staff_reason, created_at, user_id, punch:punches(server_time, lat, lng, accuracy_m, place_name, distance_m, quality_score, face_similarity, selfie_key, mocked), p:profiles!flags_user_id_fkey(full_name, hub:hubs(name))')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(300)) as unknown as (Flag & { p: PN })[];
    return r.map((f) => ({ ...f, who: f.p?.full_name ?? 'Unknown', hub: f.p?.hub?.name ?? null }));
  },
  async markFalse(id: string) { const { error } = await sb!.rpc('mark_false_flag', { p_flag: id }); rpcErr(error); },
  async accuracy(): Promise<Accuracy> {
    const since7 = new Date(Date.now() - 7 * 864e5).toISOString(), since30 = new Date(Date.now() - 30 * 864e5).toISOString();
    const [pu, fl, thr] = await Promise.all([
      sb!.from('punches').select('accuracy_m, face_similarity').gte('server_time', since7).limit(3000),
      sb!.from('flags').select('id, kind, status, details, created_at, p:profiles!flags_user_id_fkey(full_name)').gte('created_at', since30).limit(2000),
      sb!.from('settings').select('value').eq('key', 'face_threshold').maybeSingle()
    ]);
    const ps = must(pu) as { accuracy_m: number | null; face_similarity: number | null }[];
    const acc = ps.map((p) => p.accuracy_m).filter((x): x is number => x != null), faces = ps.map((p) => p.face_similarity).filter((x): x is number => x != null), t = Number(thr.data?.value ?? 80);
    const fs = must(fl) as unknown as { id: string; kind: string; status: string; details: Record<string, unknown>; created_at: string; p: { full_name: string } | null }[];
    const kinds = [...new Set(fs.map((f) => f.kind))];
    return {
      n: ps.length, gpsMedian: median(acc), gpsP95: pct(acc, 0.95), within50: acc.length ? Math.round((acc.filter((a) => a <= 50).length / acc.length) * 100) : null,
      spread: bucket(acc, [10, 25, 50, 100, Infinity], 'm'),
      faceN: faces.length, facePass: faces.length ? Math.round((faces.filter((f) => f >= t).length / faces.length) * 1000) / 10 : null,
      faceAvg: faces.length ? Math.round(faces.reduce((a, b) => a + b, 0) / faces.length) : null, faceSpread: bucket(faces, [70, 80, 90, Infinity], '%').reverse(),
      rules: kinds.map((k) => { const x = fs.filter((f) => f.kind === k); return { kind: k, raised: x.length, valid: x.filter((f) => f.status === 'valid').length, violation: x.filter((f) => f.status === 'violation').length, falseFlags: x.filter((f) => f.details?.false_flag_at).length }; }).sort((a, b) => b.raised - a.raised),
      falseList: fs.filter((f) => f.details?.false_flag_at).map((f) => ({ id: f.id, who: f.p?.full_name ?? 'Unknown', kind: f.kind, at: f.created_at }))
    };
  },
  async roles(): Promise<Roles> {
    const [ro, pr, st, it, ts, tp] = await Promise.all([
      sb!.from('staff_roster').select('email, full_name, role').in('role', ['hr', 'chairman', 'tech']).order('role'),
      sb!.from('profiles').select('email, active').in('role', ['hr', 'chairman', 'tech']),
      sb!.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'staff').eq('active', true),
      sb!.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'intern').eq('active', true),
      sb!.from('staff_roster').select('email, full_name, hub_name').eq('is_test', true).order('full_name'),
      sb!.from('profiles').select('email').eq('role', 'staff')
    ]);
    const signed = new Set(((tp.data ?? []) as { email: string }[]).map((x) => x.email));
    const pm = new Map((must(pr) as { email: string; active: boolean }[]).map((p) => [p.email, p.active]));
    return {
      logins: (must(ro) as { email: string; full_name: string; role: RoleLogin['role'] }[]).map((r) => ({ email: r.email, name: r.full_name, role: r.role, signedIn: pm.has(r.email), active: pm.get(r.email) ?? true, temp: TEMP_LOGINS.includes(r.email) })),
      staff: st.count ?? 0, interns: it.count ?? 0,
      tests: ((ts.data ?? []) as { email: string; full_name: string; hub_name: string | null }[]).map((t) => ({ email: t.email, name: t.full_name, hub: t.hub_name, signedIn: signed.has(t.email) }))
    };
  },
  async addLogin(email: string, name: string, role: RoleLogin['role']) { const { error } = await sb!.rpc('add_role_login', { p_email: email, p_name: name, p_role: role }); rpcErr(error); },
  async removeLogin(email: string) { const { error } = await sb!.rpc('remove_role_login', { p_email: email }); rpcErr(error); },
  async devices(): Promise<Devices> {
    const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
    const [dv, fl] = await Promise.all([
      sb!.from('devices').select('id, user_id, platform, user_agent, status, created_at, approved_at, p:profiles!devices_user_id_fkey(full_name, hub:hubs(name))').neq('status', 'revoked').order('created_at', { ascending: false }),
      sb!.from('flags').select('user_id, kind, created_at, p:profiles!flags_user_id_fkey(full_name, hub:hubs(name))').in('kind', ['mock_location', 'device']).gte('created_at', since30).order('created_at', { ascending: false })
    ]);
    const ds = (must(dv) as unknown as { id: string; user_id: string; platform: string; user_agent: string | null; status: Device['status']; created_at: string; approved_at: string | null; p: PN }[])
      .map((d) => ({ id: d.id, userId: d.user_id, who: d.p?.full_name ?? 'Unknown', hub: d.p?.hub?.name ?? null, platform: d.platform, ua: d.user_agent, status: d.status, created_at: d.created_at, approved_at: d.approved_at }));
    const seen = new Set<string>();
    const flagged = (must(fl) as unknown as { user_id: string; kind: string; created_at: string; p: PN }[]).filter((f) => !seen.has(f.user_id) && seen.add(f.user_id))
      .map((f) => ({ userId: f.user_id, who: f.p?.full_name ?? 'Unknown', hub: f.p?.hub?.name ?? null, kind: f.kind, at: f.created_at }));
    return { pending: ds.filter((d) => d.status === 'pending'), active: ds.filter((d) => d.status === 'active'), flagged };
  },
  async decideDevice(id: string, allow: boolean) { const { error } = await sb!.rpc('decide_device', { p_id: id, p_allow: allow }); rpcErr(error); },
  async resetDevices(userId: string) { const { error } = await sb!.rpc('reset_devices', { p_user: userId }); rpcErr(error); },
  async settings(): Promise<Settings> {
    const rows = must(await sb!.from('settings').select('key, value')) as { key: string; value: unknown }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value as string | number]));
  },
  async setSetting(key: string, value: string | number) { const { error } = await sb!.rpc('set_setting', { p_key: key, p_value: value }); rpcErr(error); },
  /** CSV text for download. Every export is logged (PRD TA-08). */
  /** Same radius decision the check-in uses, run on the server. */
  async radiusTest(point: { lat: number; lng: number; accuracy: number | null }, t: { hub_id?: string; target?: { lat: number; lng: number; radius_m: number } }): Promise<RadiusResult> {
    const { data, error } = await sb!.functions.invoke('check-in', { body: { action: 'radius_test', point, ...t } });
    if (error || !data?.ok) throw new ApiError('test_failed');
    return data as RadiusResult;
  },
  async hubPunches(hubId: string): Promise<HubPunch[]> {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const r = must(await sb!.from('punches').select('lat, lng, accuracy_m, inside, server_time, kind, p:profiles!punches_user_id_fkey(full_name)').eq('target_type', 'hub').eq('target_id', hubId).gte('server_time', since).order('server_time', { ascending: false }).limit(60)) as unknown as
      { lat: number; lng: number; accuracy_m: number | null; inside: boolean | null; server_time: string; kind: string; p: { full_name: string } | null }[];
    return r.map((x) => ({ lat: x.lat, lng: x.lng, acc: x.accuracy_m, inside: x.inside, at: x.server_time, kind: x.kind, who: x.p?.full_name ?? '' }));
  },
  async purge(a: PurgeArgs): Promise<PurgeResult> {
    const { data, error } = await sb!.functions.invoke('check-in', { body: { action: 'purge', ...a } });
    if (error) { let code = 'purge_failed'; try { code = (await (error as { context?: Response }).context?.json())?.error ?? code; } catch { /* keep */ } throw new ApiError(code); }
    return data as PurgeResult;
  },
  /** How long check-ins took to save (last 7 days), from timings the phone and server record. */
  async speed(): Promise<Speed> {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const r = must(await sb!.from('punches').select('server_time, kind, timings, p:profiles!punches_user_id_fkey(full_name)').gte('server_time', since).not('timings', 'is', null).order('server_time', { ascending: false }).limit(3000)) as unknown as
      { server_time: string; kind: string; timings: Record<string, number | boolean>; p: { full_name: string } | null }[];
    const rows: SpeedRow[] = r.map((x) => { const t = x.timings ?? {}; const n = (k: string) => (typeof t[k] === 'number' ? (t[k] as number) : null);
      return { who: x.p?.full_name ?? '', at: x.server_time, kind: x.kind, total: n('total_ms') ?? n('server_ms'), gps: n('gps_wait_ms'), upload: n('upload_ms'), server: n('server_ms'), oneShot: !!t.one_shot }; });
    const tot = rows.map((x) => x.total).filter((x): x is number => x != null);
    return { n: rows.length, median: median(tot), p95: pct(tot, 0.95), over60: tot.filter((x) => x > 60000).length, slowest: [...rows].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 12) };
  },
  async selfieStats(): Promise<SelfieStats> {
    const r = must(await sb!.from('punches').select('user_id, server_time, p:profiles!punches_user_id_fkey(full_name, hub:hubs(name))').not('selfie_key', 'is', null).order('server_time', { ascending: false }).limit(20000)) as unknown as
      { user_id: string; server_time: string; p: PN }[];
    const m = new Map<string, SelfieStats['people'][number]>();
    for (const x of r) { const e = m.get(x.user_id); if (e) e.count++; else m.set(x.user_id, { id: x.user_id, name: x.p?.full_name ?? 'Unknown', hub: x.p?.hub?.name ?? null, count: 1, last: x.server_time }); }
    return { total: r.length, people: [...m.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  },
  async personSelfies(userId: string): Promise<SelfieRow[]> {
    const r = must(await sb!.from('punches').select('id, kind, server_time, place_name, selfie_key').eq('user_id', userId).not('selfie_key', 'is', null).order('server_time', { ascending: false }).limit(200)) as
      { id: string; kind: string; server_time: string; place_name: string | null; selfie_key: string }[];
    return r.map((x) => ({ id: x.id, kind: x.kind, at: x.server_time, place: x.place_name, key: x.selfie_key }));
  },
  async removeSelfie(punchId: string, reason: string) {
    const { error } = await sb!.functions.invoke('check-in', { body: { action: 'remove_selfie', punch_id: punchId, reason } });
    if (error) throw new ApiError('remove_failed');
  },
  async addTestStaff(email: string, name: string, hub: string) { const { error } = await sb!.rpc('add_test_staff', { p_email: email, p_name: name, p_hub: hub }); rpcErr(error); },
  async exportCsv(kind: 'attendance' | 'audit', month: string): Promise<string> {
    const start = `${month}-01`, end = new Date(new Date(`${start}T00:00:00Z`).getTime() + 32 * 864e5).toISOString().slice(0, 7) + '-01';
    await sb!.rpc('log_action', { p_action: 'export', p_entity: kind, p_entity_id: month, p_details: {} });
    if (kind === 'attendance') {
      const rows = must(await sb!.from('attendance_days').select('day, status, band, in_time, out_time, early_out, p:profiles!attendance_days_user_id_fkey(full_name, email, employee_code, hub:hubs(name))').gte('day', start).lt('day', end).order('day')) as unknown as
        { day: string; status: string; band: string | null; in_time: string | null; out_time: string | null; early_out: boolean; p: { full_name: string; email: string; employee_code: string | null; hub: { name: string } | null } | null }[];
      const t = (x: string | null) => (x ? new Date(new Date(x).getTime() + 330 * 60000).toISOString().slice(11, 16) : '');
      return toCsv(['Date', 'Name', 'Email', 'Code', 'Hub', 'Status', 'On time', 'In', 'Out', 'Early out'],
        rows.map((r) => [r.day, r.p?.full_name ?? '', r.p?.email ?? '', r.p?.employee_code ?? '', r.p?.hub?.name ?? '', r.status, r.band === 'ok' ? 'Yes' : r.band ? 'Late' : '', t(r.in_time), t(r.out_time), r.early_out ? 'Yes' : '']));
    }
    const rows = must(await sb!.from('audit_log').select('id, created_at, actor_role, action, entity, entity_id, hash, prev_hash').gte('created_at', `${start}T00:00:00+05:30`).lt('created_at', `${end}T00:00:00+05:30`).order('id')) as
      { id: number; created_at: string; actor_role: string | null; action: string; entity: string; entity_id: string | null; hash: string; prev_hash: string | null }[];
    return toCsv(['Id', 'Time (UTC)', 'Role', 'Action', 'Table', 'Row', 'Hash', 'Previous hash'], rows.map((r) => [String(r.id), r.created_at, r.actor_role ?? 'system', r.action, r.entity, r.entity_id ?? '', r.hash, r.prev_hash ?? '']));
  }
};
function toCsv(head: string[], rows: string[][]) {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\n');
}

// ---------------- demo ----------------
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const DS = {
  settings: { office_start: '10:00', late_until: '10:15', office_end: '18:00', face_threshold: 80, same_point_days: 5, offline_flag_minutes: 30, clock_gap_minutes: 2, jump_kmh: 150, od_notice_hours: 12 } as Settings,
  logins: [
    { email: 'hr@startuptn.in', name: 'HR team', role: 'hr', signedIn: true, active: true, temp: false },
    { email: 'naveenflop@gmail.com', name: 'Naveen (test HR)', role: 'hr', signedIn: true, active: true, temp: true },
    { email: 'chairmanoffice@startuptn.in', name: 'Chairman', role: 'chairman', signedIn: true, active: true, temp: false },
    { email: 'naveenbackup7@gmail.com', name: 'Chairman (test)', role: 'chairman', signedIn: true, active: true, temp: true },
    { email: 'ai@startuptn.in', name: 'Tech admin', role: 'tech', signedIn: true, active: true, temp: false }
  ] as RoleLogin[],
  pending: [{ id: 'd1', userId: 's2', who: 'Arun K', hub: 'Chennai', platform: 'web', ua: 'Mozilla/5.0 (Linux; Android 14; Redmi Note 13) Chrome/129', status: 'pending', created_at: ago(40), approved_at: null }] as Device[],
  active: [
    { id: 'd2', userId: 's1', who: 'Kavya R', hub: 'Chennai', platform: 'web', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Safari/604.1', status: 'active', created_at: ago(9000), approved_at: null },
    { id: 'd3', userId: 's3', who: 'Ravi S', hub: 'Madurai', platform: 'web', ua: 'Mozilla/5.0 (Linux; Android 13; SM-A346E) Chrome/129', status: 'active', created_at: ago(8000), approved_at: null },
    { id: 'd4', userId: 's4', who: 'Lakshmi N', hub: 'Salem', platform: 'web', ua: 'Mozilla/5.0 (Linux; Android 14; V2250) Chrome/129', status: 'active', created_at: ago(7000), approved_at: null }
  ] as Device[],
  falseIds: new Set<string>(),
  selfies: Array.from({ length: 8 }, (_, i) => ({ id: `ps${i}`, kind: i % 2 ? 'out' : 'in', at: ago(60 + i * 720), place: 'Anna Salai, Nandanam, Chennai', key: `selfies/s1/${i}.jpg` })) as SelfieRow[],
  tests: [{ email: 'test1@startuptn.in', name: 'Test', hub: 'Chennai', signedIn: true }] as TestStaff[],
  audit: [] as AuditRow[]
};
(() => {
  const h = (i: number) => (0x9e3779b1 * (i + 7) >>> 0).toString(16).padStart(8, '0').repeat(8);
  const rows: Omit<AuditRow, 'id' | 'hash' | 'prev'>[] = [
    { at: ago(8), who: 'Kavya R', actor: 'Chairman', actorRole: 'chairman', action: 'update', entity: 'od_requests', entityId: 'o1', before: { status: 'pending', subject: 'TIDCO policy meet' }, after: { status: 'approved', subject: 'TIDCO policy meet' } },
    { at: ago(12), who: 'Vignesh P', actor: 'HR team', actorRole: 'hr', action: 'update', entity: 'flags', entityId: 'f2', before: { status: 'open', kind: 'radius' }, after: { status: 'reason_asked', kind: 'radius' } },
    { at: ago(19), who: 'Deepa V', actor: 'System', actorRole: 'system', action: 'insert', entity: 'flags', entityId: 'f1', before: null, after: { kind: 'location_changer', status: 'open' } },
    { at: ago(22), actor: 'Imran A', actorRole: 'staff', action: 'insert', entity: 'punches', entityId: 'p9', before: null, after: { kind: 'in', band: 'bad', place_name: 'Bagalur Road, Hosur' } },
    { at: ago(30), actor: 'Chairman', actorRole: 'chairman', action: 'update', entity: 'settings', entityId: 'chairman_away', before: { key: 'chairman_away', value: false }, after: { key: 'chairman_away', value: true } },
    { at: ago(48), who: 'Naresh B', actor: 'HR team', actorRole: 'hr', action: 'update', entity: 'leave_requests', entityId: 'l1', before: { status: 'pending', leave_type: 'sick' }, after: { status: 'approved', leave_type: 'sick' } },
    { at: ago(70), actor: 'HR team', actorRole: 'hr', action: 'insert', entity: 'staff_roster', entityId: 'uxnaveen@gmail.com', before: null, after: { email: 'uxnaveen@gmail.com', full_name: 'Naveen', role: 'staff' } },
    { at: ago(1500), actor: 'Tech admin', actorRole: 'tech', action: 'update', entity: 'settings', entityId: 'face_threshold', before: { key: 'face_threshold', value: 75 }, after: { key: 'face_threshold', value: 80 } }
  ];
  let prev: string | null = null; const n = rows.length;
  DS.audit = rows.map((r, i) => { const id = 2400 + n - i, hash = h(id); const row = { ...r, id, hash, prev: h(id - 1) }; prev = hash; return row; });
  void prev;
})();
const DFLAGS: Flag[] = [
  { id: 'f1', kind: 'location_changer', rule: 'R-04 same point 5+ days, spread < 1 m', details: {}, status: 'open', staff_reason: null, created_at: ago(290), user_id: 's40', who: 'Deepa V', hub: 'Villupuram', punch: { server_time: ago(295), lat: 11.93941, lng: 79.48623, accuracy_m: 5, place_name: 'Villupuram', distance_m: 40, quality_score: 18, face_similarity: 95, selfie_key: null, mocked: null } },
  { id: 'f2', kind: 'radius', rule: 'R-02 outside radius', details: {}, status: 'reason_asked', staff_reason: null, created_at: ago(260), user_id: 's41', who: 'Vignesh P', hub: 'Trichy', punch: { server_time: ago(260), lat: 10.8064, lng: 78.6851, accuracy_m: 14, place_name: 'Cantonment, Trichy', distance_m: 1400, quality_score: 86, face_similarity: 93, selfie_key: null, mocked: null } },
  { id: 'f4', kind: 'face', rule: 'R-05 face match below 80%', details: {}, status: 'valid', staff_reason: 'New glasses.', created_at: ago(2900), user_id: 's43', who: 'Sowmya S', hub: 'Chennai', punch: { server_time: ago(2900), lat: 13.0108, lng: 80.2206, accuracy_m: 8, place_name: 'Guindy, Chennai', distance_m: 22, quality_score: 88, face_similarity: 71, selfie_key: null, mocked: null } },
  { id: 'f5', kind: 'radius', rule: 'R-02 outside radius', details: {}, status: 'valid', staff_reason: 'GPS drift indoors.', created_at: ago(4300), user_id: 's5', who: 'Karthik R', hub: 'Chennai', punch: { server_time: ago(4300), lat: 13.0141, lng: 80.2271, accuracy_m: 48, place_name: 'Guindy, Chennai', distance_m: 620, quality_score: 74, face_similarity: 96, selfie_key: null, mocked: null } },
  { id: 'f6', kind: 'mock_location', rule: 'R-03 mock location app', details: {}, status: 'violation', staff_reason: null, created_at: ago(5800), user_id: 's44', who: 'Ramesh T', hub: 'Salem', punch: { server_time: ago(5800), lat: 11.6643, lng: 78.146, accuracy_m: 3, place_name: 'Salem', distance_m: 12, quality_score: 9, face_similarity: 97, selfie_key: null, mocked: true } }
];
const demo: typeof real = {
  async health() { await wait(300); return { db_ok: true, db_ms: 38, storage: 'supabase', face_match: false, geocode: 'osm', region: 'ap-south-1' }; },
  async overview() { await wait(); return { staff: 96, checkins: 83, openAlerts: 2, quality: 91, newPhones: DS.pending.length, flaggedPhones: 1, falseFlags: DS.falseIds.size + 1, selfies24: 168, facePass: null, gpsMedian: 11 }; },
  async audit() { await wait(); return DS.audit; },
  async verifyChain() { await wait(400); return { ok: true, rows: 2408 }; },
  async alerts() { await wait(); return DFLAGS.map((f) => (DS.falseIds.has(f.id) ? { ...f, details: { ...f.details, false_flag_at: ago(1) } } : f)); },
  async markFalse(id) { await wait(); DS.falseIds.add(id); },
  async accuracy() {
    await wait();
    return { n: 512, gpsMedian: 11, gpsP95: 38, within50: 96, spread: [{ l: '≤ 10 m', n: 231 }, { l: '10–25 m', n: 198 }, { l: '25–50 m', n: 63 }, { l: '50–100 m', n: 15 }, { l: '> 100 m', n: 5 }],
      faceN: 0, facePass: null, faceAvg: null, faceSpread: [],
      rules: [{ kind: 'late', raised: 21, valid: 9, violation: 4, falseFlags: 0 }, { kind: 'radius', raised: 6, valid: 3, violation: 1, falseFlags: 1 }, { kind: 'location_changer', raised: 2, valid: 0, violation: 1, falseFlags: 0 }, { kind: 'mock_location', raised: 1, valid: 0, violation: 1, falseFlags: 0 }],
      falseList: [{ id: 'f5', who: 'Karthik R', kind: 'radius', at: ago(4300) }] };
  },
  async roles() { await wait(); return { logins: DS.logins, staff: 92, interns: 4, tests: DS.tests }; },
  async addLogin(email, name, role) { await wait(); const e = email.trim().toLowerCase(); DS.logins = [...DS.logins.filter((l) => l.email !== e), { email: e, name: name || role, role, signedIn: false, active: true, temp: false }]; },
  async removeLogin(email) { await wait(); if (email === 'ai@startuptn.in') throw new ApiError('not_yourself'); DS.logins = DS.logins.filter((l) => l.email !== email); },
  async devices() { await wait(); return { pending: DS.pending, active: DS.active, flagged: [{ userId: 's44', who: 'Ramesh T', hub: 'Salem', kind: 'mock_location', at: ago(5800) }] }; },
  async decideDevice(id, allow) { await wait(); const d = DS.pending.find((x) => x.id === id)!; DS.pending = DS.pending.filter((x) => x.id !== id); if (allow) DS.active = [{ ...d, status: 'active', approved_at: new Date().toISOString() }, ...DS.active.filter((x) => x.userId !== d.userId)]; },
  async resetDevices(userId) { await wait(); DS.active = DS.active.filter((x) => x.userId !== userId); },
  async settings() { await wait(); return { ...DS.settings }; },
  async setSetting(key, value) { await wait(); DS.settings[key] = value; },
  async radiusTest(point, t) {
    await wait(300); const c = t.target ?? { lat: 13.0321, lng: 80.2436, radius_m: 300 };
    const R = 6371000, toR = (d: number) => (d * Math.PI) / 180, dl = toR(point.lat - c.lat), dg = toR(point.lng - c.lng);
    const d = 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(toR(c.lat)) * Math.cos(toR(point.lat)) * Math.sin(dg / 2) ** 2)), cr = Math.min(point.accuracy ?? 0, 100);
    return { distance_m: Math.round(d), credit_m: Math.round(cr), inside: d - cr <= c.radius_m, radius_m: c.radius_m, place: 'Anna Salai, Nandanam, Chennai' };
  },
  async hubPunches() { await wait(); return [{ lat: 13.0319, lng: 80.2434, acc: 12, inside: true, at: ago(300), who: 'Kavya R', kind: 'in' }, { lat: 13.0326, lng: 80.2441, acc: 20, inside: true, at: ago(320), who: 'Arun K', kind: 'in' }, { lat: 13.0412, lng: 80.2338, acc: 15, inside: false, at: ago(900), who: 'Ravi S', kind: 'in' }]; },
  async purge(a) { await wait(500); const n = a.scope === 'person' ? 1 : a.scope === 'test' ? 2 : a.scope === 'hub' ? 28 : 96; return { people: n, checkins: n * 6, days: n * 3, flags: Math.ceil(n / 2), od: a.what.includes('od') ? n : 0, leave: a.what.includes('leave') ? Math.ceil(n / 3) : 0, notifications: a.what.includes('notifications') ? n * 4 : 0, devices: a.what.includes('devices') ? n : 0, photos_removed: a.dry ? undefined : n * 6 }; },
  async speed() { await wait(); const S = (who: string, m: number, total: number, gps: number, up: number, sv: number) => ({ who, at: ago(m), kind: 'in', total, gps, upload: up, server: sv, oneShot: true });
    return { n: 214, median: 3400, p95: 9800, over60: 1, slowest: [S('Ravi S', 300, 64200, 14800, 900, 2100), S('Kavya R', 1500, 12400, 8200, 600, 1500), S('Arun K', 2900, 9100, 4100, 700, 1900), S('Test', 30, 3100, 300, 400, 1200)] }; },
  async selfieStats() { await wait(); return { total: DS.selfies.length + 160, people: [{ id: 's1', name: 'Kavya R', hub: 'Chennai', count: DS.selfies.length, last: ago(60) }, { id: 's2', name: 'Arun K', hub: 'Chennai', count: 44, last: ago(90) }, { id: 's3', name: 'Ravi S', hub: 'Madurai', count: 38, last: ago(120) }, { id: 'st', name: 'Test', hub: 'Chennai', count: 78, last: ago(20) }] }; },
  async personSelfies() { await wait(); return DS.selfies; },
  async removeSelfie(id) { await wait(); DS.selfies = DS.selfies.filter((x) => x.id !== id); },
  async addTestStaff(email, name, hub) { await wait(); DS.tests = [...DS.tests, { email: email.trim().toLowerCase(), name: name || 'Test staff', hub, signedIn: false }]; },
  async exportCsv(kind, month) { await wait(); return kind === 'attendance' ? `Date,Name,Hub,Status\n${month}-01,Kavya R,Chennai,present` : `Id,Action\n1,update`; }
};

export const tech = DEMO ? demo : real;
/** Rough phone name from the browser's user agent, for the device list. */
export function phoneName(ua: string | null) {
  if (!ua) return 'Unknown phone';
  if (/iPhone/.test(ua)) return `iPhone · iOS ${(ua.match(/OS (\d+)[_.](\d+)/) ?? []).slice(1, 3).join('.') || ''}`.trim();
  const m = ua.match(/Android ([\d.]+);\s*([^;)]+)/);
  if (m) return `${m[2].replace(/ Build.*/, '').trim()} · Android ${m[1]}`;
  if (/Windows/.test(ua)) return 'Windows PC'; if (/Macintosh/.test(ua)) return 'Mac';
  return 'Browser';
}
