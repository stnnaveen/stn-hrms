// Chairman data layer. Chairman reads everything (RLS: sees_all), decides OD, sets In / Away.
// Numbers are computed here from today's rows: about 100 people, so one round of queries is enough.
import { sb, DEMO, ApiError } from './api';
import type { Flag } from './hr';

export type Cat = 'in' | 'notin' | 'od' | 'lv';
export interface Staff {
  id: string; name: string; email: string; hub: string; designation: string | null;
  cat: Cat; inTime: string | null; outTime: string | null; band: 'ok' | 'warn' | 'bad' | null; early: boolean;
  od?: { subject: string; venue: string; starts_at: string; ends_at: string } | null; leaveType?: string | null;
}
export interface Snapshot { staff: Staff[]; hubs: string[]; away: boolean; trend: { day: string; pct: number }[] }
export interface OdItem {
  id: string; who: string; userId: string; hub: string; subject: string; note: string | null; venue: string;
  starts_at: string; ends_at: string; created_at: string; status: string;
  decided_role: string | null; decided_at: string | null; return_reason: string | null;
}
export interface LeaveItem { id: string; who: string; hub: string; leave_type: string; starts_on: string; ends_on: string; reason: string | null; status: string; assigned_by_hr: boolean }

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const istMin = (iso: string) => { const d = new Date(iso); return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440; };
const must = <T,>(r: { data: T | null; error: unknown }): T => { if (r.error) throw new ApiError('load_failed'); return r.data as T; };
type P = { full_name: string; hub: { name: string } | null };

// ---------------- real ----------------
const real = {
  async snapshot(): Promise<Snapshot> {
    const today = istToday();
    const startIso = new Date(`${today}T00:00:00+05:30`).toISOString(), endIso = new Date(`${today}T23:59:59+05:30`).toISOString();
    const since = new Date(Date.now() - 30 * 864e5 + 330 * 60000).toISOString().slice(0, 10);
    const [ps, days, ods, lvs, hubs, away, hist] = await Promise.all([
      sb!.from('profiles').select('id, full_name, email, designation, hub:hubs(name)').in('role', ['staff', 'intern']).eq('active', true),
      sb!.from('attendance_days').select('user_id, in_time, out_time, band, early_out, status').eq('day', today),
      sb!.from('od_requests').select('user_id, subject, venue_name, starts_at, ends_at').eq('status', 'approved').lte('starts_at', endIso).gte('ends_at', startIso),
      sb!.from('leave_requests').select('user_id, leave_type').eq('status', 'approved').lte('starts_on', today).gte('ends_on', today),
      sb!.from('hubs').select('name').eq('active', true).order('name'),
      sb!.from('settings').select('value').eq('key', 'chairman_away').maybeSingle(),
      sb!.from('attendance_days').select('day, band').gte('day', since).not('in_time', 'is', null)
    ]);
    const dmap = new Map((must(days) as { user_id: string }[]).map((d) => [d.user_id, d as unknown as { in_time: string | null; out_time: string | null; band: Staff['band']; early_out: boolean; status: string }]));
    const omap = new Map((must(ods) as { user_id: string; subject: string; venue_name: string; starts_at: string; ends_at: string }[]).map((o) => [o.user_id, o]));
    const lmap = new Map((must(lvs) as { user_id: string; leave_type: string }[]).map((l) => [l.user_id, l.leave_type]));
    const staff: Staff[] = (must(ps) as unknown as { id: string; full_name: string; email: string; designation: string | null; hub: { name: string } | null }[]).map((p) => {
      const d = dmap.get(p.id), o = omap.get(p.id), lv = lmap.get(p.id);
      const cat: Cat = lv ? 'lv' : d?.in_time ? 'in' : o ? 'od' : 'notin';
      return { id: p.id, name: p.full_name, email: p.email, hub: p.hub?.name ?? 'No hub', designation: p.designation, cat,
        inTime: d?.in_time ?? null, outTime: d?.out_time ?? null, band: d?.band ?? null, early: !!d?.early_out,
        od: o ? { subject: o.subject, venue: o.venue_name, starts_at: o.starts_at, ends_at: o.ends_at } : null, leaveType: lv ?? null };
    });
    const byDay = new Map<string, { n: number; ok: number }>();
    for (const r of must(hist) as { day: string; band: string | null }[]) { const x = byDay.get(r.day) ?? { n: 0, ok: 0 }; x.n++; if (r.band === 'ok') x.ok++; byDay.set(r.day, x); }
    const trend = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, x]) => ({ day, pct: Math.round((x.ok / x.n) * 100) }));
    return { staff, hubs: (must(hubs) as { name: string }[]).map((h) => h.name), away: away.data?.value === true, trend };
  },
  async ods(): Promise<{ pending: OdItem[]; decided: OdItem[] }> {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = must(await sb!.from('od_requests')
      .select('id, user_id, subject, note, venue_name, starts_at, ends_at, created_at, status, decided_role, decided_at, return_reason, p:profiles!od_requests_user_id_fkey(full_name, hub:hubs(name))')
      .or(`status.eq.pending,decided_at.gte.${since}`).order('created_at', { ascending: false }).limit(100)) as unknown as (Omit<OdItem, 'who' | 'hub' | 'venue' | 'userId'> & { user_id: string; venue_name: string; p: P })[];
    const all: OdItem[] = r.map((x) => ({ ...x, userId: x.user_id, venue: x.venue_name, who: x.p.full_name, hub: x.p.hub?.name ?? 'No hub' }));
    return { pending: all.filter((x) => x.status === 'pending').sort((a, b) => a.starts_at.localeCompare(b.starts_at)), decided: all.filter((x) => x.status === 'approved' || x.status === 'returned').sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? '')) };
  },
  async leaves(): Promise<LeaveItem[]> {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = must(await sb!.from('leave_requests').select('id, leave_type, starts_on, ends_on, reason, status, assigned_by_hr, created_at, p:profiles!leave_requests_user_id_fkey(full_name, hub:hubs(name))')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(60)) as unknown as (Omit<LeaveItem, 'who' | 'hub'> & { p: P })[];
    return r.map((x) => ({ ...x, who: x.p.full_name, hub: x.p.hub?.name ?? 'No hub' }));
  },
  async setAway(away: boolean) { const { error } = await sb!.rpc('set_chairman_away', { p_away: away }); if (error) throw new ApiError('save_failed'); },
  async decideOd(id: string, d: 'approved' | 'returned', reason?: string) { const { error } = await sb!.rpc('decide_od', { p_id: id, p_decision: d, p_reason: reason ?? null }); if (error) throw new ApiError(error.message); },
  async alerts(): Promise<Flag[]> {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = must(await sb!.from('flags')
      .select('id, kind, rule, details, status, staff_reason, created_at, user_id, punch:punches(server_time, lat, lng, accuracy_m, place_name, distance_m, quality_score, face_similarity, selfie_key, mocked), p:profiles!flags_user_id_fkey(full_name, hub:hubs(name))')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(150)) as unknown as (Flag & { p: P })[];
    return r.filter((f) => f.kind !== 'late' || f.staff_reason || f.status !== 'open').map((f) => ({ ...f, who: f.p.full_name, hub: f.p.hub?.name ?? null }));
  }
};

// ---------------- demo ----------------
const HUBS = ['Chennai', 'Coimbatore', 'Madurai', 'Salem', 'Trichy', 'Erode', 'Hosur', 'Tirunelveli', 'Thoothukudi', 'Villupuram'];
const SIZES = [28, 12, 11, 8, 8, 7, 7, 6, 5, 4];
const NAMES = ['Kavya R', 'Arun K', 'Ravi S', 'Lakshmi N', 'Karthik R', 'Priya S', 'Divya M', 'Naresh B', 'Suresh P', 'Anitha R', 'Vignesh P', 'Kowsalya V', 'Deepa V', 'Sathish K', 'Bharathi L', 'Imran A', 'Sanjay T', 'Harini T', 'Gokul M', 'Revathi K', 'Prakash J', 'Nithya G', 'Bala S', 'Keerthana R'];
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const at = (h: number, m: number) => new Date(`${istToday()}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`).toISOString();
const D = (() => {
  const staff: Staff[] = []; let k = 0;
  HUBS.forEach((h, hi) => { for (let i = 0; i < SIZES[hi]; i++) {
    const r = rnd(), name = `${NAMES[k % NAMES.length].split(' ')[0]} ${String.fromCharCode(65 + (k % 26))}`; k++;
    const cat: Cat = r < 0.06 ? 'notin' : r < 0.12 ? 'od' : r < 0.16 ? 'lv' : 'in';
    const inM = 9 * 60 + 35 + Math.floor(rnd() * 50), late = inM > 600, nowM = istMin(new Date().toISOString());
    const outM = nowM >= 1080 && rnd() < 0.85 ? 1080 + Math.floor(rnd() * 60) : nowM >= 960 && rnd() < 0.08 ? 960 + Math.floor(rnd() * 60) : null;
    staff.push({ id: `s${k}`, name, email: `${name.split(' ')[0].toLowerCase()}${k}@startuptn.in`, hub: h, designation: 'Project Associate', cat,
      inTime: cat === 'in' ? at(Math.floor(inM / 60), inM % 60) : null, outTime: cat === 'in' && outM ? at(Math.floor(outM / 60), outM % 60) : null,
      band: cat === 'in' ? (inM <= 600 ? 'ok' : inM <= 615 ? 'warn' : 'bad') : null, early: !!(outM && outM < 1080),
      od: cat === 'od' ? { subject: 'Collector review', venue: `Collectorate, ${h}`, starts_at: at(11, 0), ends_at: at(17, 0) } : null, leaveType: cat === 'lv' ? 'Casual' : null });
    void late;
  } });
  const trend = Array.from({ length: 22 }, (_, i) => ({ day: new Date(Date.now() - (22 - i) * 864e5).toISOString().slice(0, 10), pct: 86 + Math.round(rnd() * 10) }));
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();
  const pending: OdItem[] = [
    { id: 'o1', who: 'Kavya R', userId: 's1', hub: 'Chennai', subject: 'TIDCO policy meet', note: 'Policy inputs for the startup fund scheme.', venue: 'Guindy, Chennai', starts_at: iso(-4 * 1440 - 60), ends_at: iso(-4 * 1440 - 210), created_at: iso(1500), status: 'pending', decided_role: null, decided_at: null, return_reason: null },
    { id: 'o2', who: 'Bharathi L', userId: 's30', hub: 'Madurai', subject: 'District collector review', note: 'Quarterly review with the district collector.', venue: 'Collectorate, Madurai', starts_at: iso(-3 * 1440), ends_at: iso(-3 * 1440 - 480), created_at: iso(900), status: 'pending', decided_role: null, decided_at: null, return_reason: null },
    { id: 'o3', who: 'Gokul M', userId: 's31', hub: 'Coimbatore', subject: 'Investor demo day', note: 'Pitching 4 hub startups to angel investors.', venue: 'Codissia, Coimbatore', starts_at: iso(-180), ends_at: iso(-360), created_at: iso(240), status: 'pending', decided_role: null, decided_at: null, return_reason: null }
  ];
  const decided: OdItem[] = [
    { id: 'o4', who: 'Priya S', userId: 's6', hub: 'Coimbatore', subject: 'College outreach', note: 'Startup awareness talk.', venue: 'PSG Tech, Coimbatore', starts_at: iso(2880), ends_at: iso(2760), created_at: iso(5000), status: 'approved', decided_role: 'chairman', decided_at: iso(2900), return_reason: null },
    { id: 'o5', who: 'Karthik R', userId: 's5', hub: 'Chennai', subject: 'Startup expo', note: 'StartupTN stall.', venue: 'Chennai Trade Centre', starts_at: iso(4320), ends_at: iso(3900), created_at: iso(7000), status: 'approved', decided_role: 'hr', decided_at: iso(4400), return_reason: null },
    { id: 'o6', who: 'Arun K', userId: 's2', hub: 'Chennai', subject: 'Bank tie-up meeting', note: 'Credit linkage.', venue: 'SBI LHO, Chennai', starts_at: iso(1500), ends_at: iso(1440), created_at: iso(2000), status: 'returned', decided_role: 'chairman', decided_at: iso(1700), return_reason: 'Need details' }
  ];
  const leaves: LeaveItem[] = [
    { id: 'l1', who: 'Naresh B', hub: 'Chennai', leave_type: 'sick', starts_on: istToday(), ends_on: istToday(), reason: 'Fever since last night', status: 'approved', assigned_by_hr: false },
    { id: 'l2', who: 'Anitha R', hub: 'Salem', leave_type: 'casual', starts_on: '2026-11-12', ends_on: '2026-11-13', reason: 'Sister’s wedding', status: 'pending', assigned_by_hr: false },
    { id: 'l3', who: 'Revathi K', hub: 'Madurai', leave_type: 'maternity', starts_on: '2026-11-16', ends_on: '2027-05-14', reason: null, status: 'approved', assigned_by_hr: true }
  ];
  return { staff, trend, pending, decided, leaves, away: false };
})();
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const demo: typeof real = {
  async snapshot() { await wait(); return { staff: D.staff, hubs: HUBS, away: D.away, trend: D.trend }; },
  async ods() { await wait(); return { pending: [...D.pending], decided: [...D.decided] }; },
  async leaves() { await wait(); return D.leaves; },
  async setAway(a) { await wait(150); D.away = a; },
  async decideOd(id, d, reason) {
    await wait(); const o = D.pending.find((x) => x.id === id)!; D.pending = D.pending.filter((x) => x.id !== id);
    D.decided.unshift({ ...o, status: d, decided_role: 'chairman', decided_at: new Date().toISOString(), return_reason: reason ?? null });
  },
  async alerts() {
    await wait(); const iso = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    return [
      { id: 'f1', kind: 'location_changer', rule: 'R-04 same point 5+ days, spread < 1 m', details: {}, status: 'open', staff_reason: null, created_at: iso(290), user_id: 's40', who: 'Deepa V', hub: 'Villupuram', punch: { server_time: iso(295), lat: 11.93941, lng: 79.48623, accuracy_m: 5, place_name: 'Villupuram', distance_m: 40, quality_score: 18, face_similarity: 95, selfie_key: null, mocked: null } },
      { id: 'f2', kind: 'radius', rule: 'R-02 distance > 500 m', details: {}, status: 'reason_asked', staff_reason: null, created_at: iso(260), user_id: 's41', who: 'Vignesh P', hub: 'Trichy', punch: { server_time: iso(260), lat: 10.8064, lng: 78.6851, accuracy_m: 14, place_name: 'Cantonment, Trichy', distance_m: 1400, quality_score: 86, face_similarity: 93, selfie_key: null, mocked: null } },
      { id: 'f3', kind: 'late', rule: 'R-01 check-in after 10:15', details: {}, status: 'valid', staff_reason: 'Bus broke down on Hosur road.', created_at: iso(268), user_id: 's42', who: 'Imran A', hub: 'Hosur', punch: { server_time: iso(268), lat: 12.7409, lng: 77.8253, accuracy_m: 9, place_name: 'Bagalur Road, Hosur', distance_m: 40, quality_score: 91, face_similarity: 97, selfie_key: null, mocked: null } },
      { id: 'f4', kind: 'face', rule: 'R-05 face match below 80%', details: {}, status: 'valid', staff_reason: 'New glasses.', created_at: iso(2900), user_id: 's43', who: 'Sowmya S', hub: 'Chennai', punch: { server_time: iso(2900), lat: 13.0108, lng: 80.2206, accuracy_m: 8, place_name: 'Guindy, Chennai', distance_m: 22, quality_score: 88, face_similarity: 71, selfie_key: null, mocked: null } }
    ] as Flag[];
  }
};

export const chair = DEMO ? demo : real;
export { istMin };
