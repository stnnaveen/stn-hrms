// HR data layer. Real mode uses Supabase (RLS lets HR read everything); demo mode uses sample data.
import { sb, DEMO, ApiError, api, type MyMonth } from './api';

export interface HrToday {
  staff: number; checked_in: number; late: number; od: number; leave: number;
  pending_leave: number; pending_od: number; open_flags: number; chairman_away: boolean; finger?: number; checked_out?: number;
  absent?: number; holiday?: { name: string; kind: 'govt' | 'office' } | null; leave_approver?: string; od_approver?: string;
}
export interface Person {
  id: string; full_name: string; email: string; role: string; designation: string | null; hub: string | null; phone: string | null;
  employee_code: string | null; active: boolean; face_status: string;
  invited?: boolean;               // on the roster, has not signed in yet
  today?: { in_time: string | null; out_time: string | null; band: string | null; status: string } | null;
  geo?: 'in' | 'out' | null;   // today's check-in inside / outside the radius (HR only)
  test?: boolean;              // Tech admin's test staff (left out of HR numbers)
  bio?: { in_at: string; out_at: string | null; band: string } | null;   // today's fingerprint (HR only)
  odToday?: boolean; leaveToday?: boolean; disputesToday?: number;      // approved OD / leave today, disputes raised today
  absentToday?: boolean; markNote?: string | null;                       // HR marked this day absent (or leave)
  reports_to?: string | null;                                            // reporting person's email
}
/** One person-day as the server counts it (hr_board): merged by the hub's check-in method. */
export interface BoardRow {
  email: string; user_id: string | null; day: string; method: 'bio' | 'selfie' | 'both'; band: 'ok' | 'warn' | 'bad' | null; status: string; early_out: boolean;
  in_time: string | null; out_time: string | null; source: 'app' | 'bio' | 'both'; in_src: 'app' | 'bio' | null; out_src: 'app' | 'bio' | null;
  in_punch: string | null; bio_in: string | null; bio_out: string | null;
}
export interface RoutesFor { leave: { route: string; name: string; set: string | null }; od: { route: string; name: string; set: string | null }; default_leave: string; default_od: string; reports_to: string | null; reports_to_name: string | null; reports_to_signed_in: boolean }
export interface MarkQuery { id: string; who: string; hub: string | null; day: string; mark: 'absent' | 'leave'; message: string; status: string; clarify_at: string | null; created_at: string }
export interface HistoryItem { kind: 'od' | 'leave'; id: string; who: string; hub: string | null; title: string; status: string; decided_at: string; by: string | null }
export interface Holiday { day: string; name: string; kind: 'govt' | 'office' }
export interface DayMark { email: string; day: string; mark: 'absent' | 'leave'; leave_type: string | null; note: string | null }
export interface Route { kind: 'od' | 'leave'; id: string; route: 'hr' | 'chairman' | 'reporting'; approver_name: string; can_decide: boolean }
export interface LeaveReq { id: string; who: string; hub: string | null; leave_type: string; starts_on: string; ends_on: string; half_day: string | null; reason: string | null; status: string; created_at: string; clarify_at?: string | null }
export interface OdReq { id: string; who: string; hub: string | null; subject: string; note: string | null; venue_name: string; venue_place?: string | null; venue_url?: string | null; venue_lat?: number | null; venue_lng?: number | null; starts_at: string; ends_at: string; status: string; created_at: string; clarify_at?: string | null }
export interface Flag {
  id: string; kind: string; rule: string; details: Record<string, unknown>; status: string; staff_reason: string | null; created_at: string;
  user_id: string; who: string; hub: string | null;
  punch: { server_time: string; lat: number; lng: number; accuracy_m: number | null; place_name: string | null; distance_m: number | null;
    quality_score: number | null; face_similarity: number | null; selfie_key: string | null; mocked: boolean | null;
    target_type?: string | null; target_id?: string | null; inside?: boolean | null } | null;
}
export interface Hub { id: string; name: string; lat: number; lng: number; radius_m: number; maps_url: string | null; active: boolean; staff?: number; pin_set_at?: string | null; checkin_method?: 'bio' | 'selfie' | 'both' }
export interface Pin { server_time: string; lat: number; lng: number; accuracy_m: number | null }
export interface DayPunch { id?: string; kind: 'in' | 'out'; server_time: string; lat: number; lng: number; place_name: string | null; band: string | null; early_out: boolean; selfie_key: string | null; distance_m: number | null; inside?: boolean | null; accuracy_m?: number | null; target_type?: string | null; target_id?: string | null }
export interface PresenceDay { tracked: boolean; reason?: string; from?: string; to?: string; inside_min: number; outside_min: number; od_min: number; no_signal_min: number;
  trips: { from: string; to: string; min: number; max_m: number; ongoing?: boolean }[]; samples: number; last_at?: string | null; last_inside?: boolean | null }
export interface LiveRow { user_id: string | null; full_name: string; hub: string | null; lat: number | null; lng: number | null; accuracy_m: number | null; at: string | null; inside: boolean | null; target_type: string | null; state: 'inside' | 'outside' | 'od' | 'no_signal' | 'not_started' | 'checked_out' | 'no_app'; checked_in: boolean }
export interface PresenceRow { user_id: string | null; full_name: string; hub: string | null; inside_min: number; outside_min: number; od_min: number; no_signal_min: number; trips: number; longest_trip: number; last_at: string | null; last_inside: boolean | null; tracked: boolean; samples: number }
export interface PresenceNow { user_id: string; outside_min: number; no_signal_min: number; trips: number; last_at: string | null; last_inside: boolean | null }
export interface PersonDetail {
  holidays?: Holiday[]; marks?: DayMark[];
  punches: DayPunch[];
  /** late / early-out asks on today's punches: whether a reason was asked and the staff answer */
  asks?: { id: string; punch_id: string; kind: 'late' | 'early_out'; status: string; staff_reason: string | null }[];
  days: { day: string; band: string | null; status: string; early_out: boolean; in_time: string | null; out_time: string | null }[];
  ods: { id: string; subject: string; venue_name: string; starts_at: string; ends_at: string; status: string }[];
  leaves: { id: string; leave_type: string; starts_on: string; ends_on: string; status: string }[];
}

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const must = <T,>(r: { data: T | null; error: unknown }): T => { if (r.error) throw new ApiError('load_failed'); return r.data as T; };

// ---------------- real ----------------
// ---- selfie links: batch keys asked for within 40 ms into one server call, cache for 4 minutes
const linkCache = new Map<string, { url: string | null; at: number }>();
let batch: { key: string; res: (u: string | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
function selfieLink(key: string): Promise<string | null> {
  const hit = linkCache.get(key);
  if (hit && Date.now() - hit.at < 240000) return Promise.resolve(hit.url);
  return new Promise((res) => {
    batch.push({ key, res });
    if (!timer) timer = setTimeout(async () => {
      const b = batch; batch = []; timer = null;
      for (let i = 0; i < b.length; i += 100) {
        const part = b.slice(i, i + 100);
        let urls: Record<string, string | null> = {};
        try { const { data } = await sb!.functions.invoke('check-in', { body: { action: 'selfie_urls', keys: part.map((x) => x.key) } }); urls = data?.urls ?? {}; } catch { /* show placeholders */ }
        for (const x of part) { const u = urls[x.key] ?? null; linkCache.set(x.key, { url: u, at: Date.now() }); x.res(u); }
      }
    }, 40);
  });
}

/** This month's holidays and HR marks for one person (calendar). */
async function monthExtras(email: string): Promise<{ holidays: Holiday[]; marks: DayMark[] }> {
  const n = new Date(Date.now() + 330 * 60000), from = n.toISOString().slice(0, 8) + '01';
  const to = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);   // real month end (30 Nov, not 31)
  const [h, m] = await Promise.all([
    sb!.from('holidays').select('day, name, kind').gte('day', from).lte('day', to),
    sb!.from('day_marks').select('email, day, mark, leave_type, note').eq('email', email).gte('day', from).lte('day', to)
  ]);
  return { holidays: (h.data ?? []) as Holiday[], marks: (m.data ?? []) as DayMark[] };
}
async function personDaysByEmail(email: string): Promise<PersonDetail['days']> {
  const ist = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const { data, error } = await sb!.rpc('hr_person_days', { p_email: email, p_from: ist.slice(0, 8) + '01', p_to: ist });
  if (error) throw new ApiError('load_failed');
  return (data ?? []) as PersonDetail['days'];
}

const real = {
  async today(): Promise<HrToday> { return must(await sb!.rpc('hr_today')) as HrToday; },
  async people(day: string = istToday()): Promise<Person[]> {
    const ps = must(await sb!.from('profiles').select('id, full_name, email, role, designation, phone, employee_code, active, face_status, hub:hubs(name)').in('role', ['staff', 'intern']).order('full_name'));
    // the day as it counts: selfie and fingerprint merged on the server by each hub's check-in method
    const board = must(await sb!.rpc('hr_board', { p_from: day, p_to: day })) as BoardRow[];
    const byEmail = new Map(board.map((b) => [b.email, b]));
    const ins = board.map((b) => b.in_punch).filter(Boolean) as string[];
    const geo = new Map<string, boolean | null>();
    if (ins.length) for (const x of must(await sb!.from('punches').select('id, inside').in('id', ins)) as { id: string; inside: boolean | null }[]) geo.set(x.id, x.inside);
    const dayOf = (email: string) => {
      const b = byEmail.get(email); if (!b) return { today: null, geo: null, bio: null };
      const g = b.in_punch ? geo.get(b.in_punch) : undefined;
      return { today: { in_time: b.in_time, out_time: b.out_time, band: b.band, status: b.status },
        geo: g == null ? null : g ? 'in' as const : 'out' as const,
        bio: b.bio_in ? { in_at: b.bio_in, out_at: b.bio_out, band: b.in_src === 'bio' ? b.band ?? 'ok' : 'ok' } : null };
    };
    const people = (ps as unknown as (Person & { hub: { name: string } | null })[]).map((p) => ({ ...p, hub: p.hub?.name ?? null, ...dayOf(p.email) }));
    const roster = must(await sb!.from('staff_roster').select('email, full_name, role, designation, hub_name, phone, employee_code, is_test').in('role', ['staff', 'intern'])) as
      { email: string; full_name: string; role: string; designation: string | null; hub_name: string | null; phone: string | null; employee_code: string | null; is_test: boolean }[];
    const tests = new Set(roster.filter((r) => r.is_test).map((r) => r.email));
    people.forEach((p) => { (p as Person).test = tests.has(p.email); });
    const known = new Set(people.map((p) => p.email));
    const invited: Person[] = roster.filter((r) => !known.has(r.email)).map((r) => ({
      id: `invite:${r.email}`, full_name: r.full_name, email: r.email, role: r.role, designation: r.designation, hub: r.hub_name, phone: r.phone,
      employee_code: r.employee_code, active: true, face_status: 'none', invited: true, test: r.is_test, ...dayOf(r.email) }));
    const all: Person[] = [...people, ...invited];
    // approved OD / leave today and disputes raised today (signed-in staff only: requests and flags need an account)
    const t0 = new Date(`${day}T00:00:00+05:30`).toISOString(), t1 = new Date(`${day}T23:59:59+05:30`).toISOString();
    const [odR, lvR, flR] = await Promise.all([
      sb!.from('od_requests').select('user_id').eq('status', 'approved').lte('starts_at', t1).gte('ends_at', t0),
      sb!.from('leave_requests').select('user_id').eq('status', 'approved').lte('starts_on', day).gte('ends_on', day),
      sb!.from('flags').select('user_id, kind, status, staff_reason').gte('created_at', t0).lte('created_at', t1)
    ]);
    const odSet = new Set(((odR.data ?? []) as { user_id: string }[]).map((x) => x.user_id));
    const lvSet = new Set(((lvR.data ?? []) as { user_id: string }[]).map((x) => x.user_id));
    const flN = new Map<string, number>();
    for (const f of (flR.data ?? []) as { user_id: string; kind: string; status: string; staff_reason: string | null }[])
      if (f.kind !== 'late' || f.staff_reason || f.status === 'reason_asked') flN.set(f.user_id, (flN.get(f.user_id) ?? 0) + 1);
    const [mkR, rtR] = await Promise.all([
      sb!.from('day_marks').select('email, mark, note').eq('day', day),
      sb!.from('staff_roster').select('email, reports_to')
    ]);
    const mk = new Map(((mkR.data ?? []) as { email: string; mark: string; note: string | null }[]).map((m) => [m.email, m]));
    const rt = new Map(((rtR.data ?? []) as { email: string; reports_to: string | null }[]).map((r) => [r.email, r.reports_to]));
    return all.map((p) => ({ ...p, odToday: odSet.has(p.id) || p.today?.status === 'od', reports_to: rt.get(p.email) ?? null,
      leaveToday: lvSet.has(p.id) || p.today?.status === 'leave' || mk.get(p.email)?.mark === 'leave',
      absentToday: mk.get(p.email)?.mark === 'absent', markNote: mk.get(p.email)?.note ?? null, disputesToday: flN.get(p.id) ?? 0 }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  },
  /** HR calendar by email, app and fingerprint days merged (works before the person signs in). */
  async personDays(email: string): Promise<PersonDetail['days']> { return personDaysByEmail(email); },
  async monthExtras(email: string) { return monthExtras(email); },
  async holidays(year?: number): Promise<Holiday[]> {
    const y = year ?? Number(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 4));
    return must(await sb!.from('holidays').select('day, name, kind').gte('day', `${y}-01-01`).lte('day', `${y + 1}-12-31`).order('day')) as Holiday[];
  },
  async saveHoliday(day: string, name: string, kind: 'govt' | 'office') { const { error } = await sb!.rpc('save_holiday', { p_day: day, p_name: name, p_kind: kind }); if (error) throw new ApiError(error.message); },
  async deleteHoliday(day: string) { const { error } = await sb!.rpc('delete_holiday', { p_day: day }); if (error) throw new ApiError(error.message); },
  async markOf(email: string, day: string): Promise<DayMark | null> { return ((await sb!.from('day_marks').select('email, day, mark, leave_type, note').eq('email', email).eq('day', day)).data ?? [])[0] as DayMark ?? null; },
  async setDayMark(email: string, day: string, mark: 'absent' | 'leave' | null, leaveType?: string, note?: string) { const { error } = await sb!.rpc('set_day_mark', { p_email: email, p_day: day, p_mark: mark, p_leave_type: leaveType ?? null, p_note: note ?? null }); if (error) throw new ApiError(error.message.replace(/^.*?:\s*/, '')); },
  async setReportsTo(email: string, reportsTo: string | null) { const { error } = await sb!.rpc('set_reports_to', { p_email: email, p_reports_to: reportsTo }); if (error) throw new ApiError(error.message.replace(/^.*?:\s*/, '')); },
  async setApprover(kind: 'leave' | 'od', value: string) { const { error } = await sb!.rpc('set_approver', { p_kind: kind, p_value: value }); if (error) throw new ApiError(error.message); },
  /** Light list for pickers: everyone on the staff list (name, hub, signed in or not). */
  async rosterLite(): Promise<{ email: string; full_name: string; hub: string | null; invited: boolean }[]> {
    const [r, p] = await Promise.all([
      sb!.from('staff_roster').select('email, full_name, hub_name, is_test').in('role', ['staff', 'intern']).order('full_name'),
      sb!.from('profiles').select('email, active').in('role', ['staff', 'intern'])
    ]);
    const act = new Map(((p.data ?? []) as { email: string; active: boolean }[]).map((x) => [x.email, x.active]));
    return ((must(r) as { email: string; full_name: string; hub_name: string | null; is_test: boolean }[])).filter((x) => !x.is_test && act.get(x.email) !== false)
      .map((x) => ({ email: x.email, full_name: x.full_name, hub: x.hub_name, invited: !act.has(x.email) }));
  },
  /** One person's month, exactly as the staff member sees it (same server function). */
  async personMonth(email: string, month: string): Promise<MyMonth> { return must(await sb!.rpc('hr_person_month', { p_email: email, p_month: month })) as MyMonth; },
  /** Leave and OD approver for one staff member (null = follow Approvals). */
  async setStaffApprover(email: string, kind: 'leave' | 'od', value: string | null) { const { error } = await sb!.rpc('set_staff_approver', { p_email: email, p_kind: kind, p_value: value }); if (error) throw new ApiError(error.message); },
  /** Open queries staff raised on HR marks (and the last 30 days' answered ones). */
  async markQueries(): Promise<MarkQuery[]> {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = must(await sb!.from('mark_queries').select('id, day, mark, message, status, clarify_at, created_at, p:profiles!mark_queries_user_id_fkey(full_name, hub:hubs(name))')
      .or(`status.eq.pending,decided_at.gte.${since}`).order('created_at', { ascending: false }).limit(100)) as unknown as (Omit<MarkQuery, 'who' | 'hub'> & { p: { full_name: string; hub: { name: string } | null } })[];
    return r.map((x) => ({ ...x, who: x.p.full_name, hub: x.p.hub?.name ?? null }));
  },
  /** Where this person's leave and OD go now (approver settings + reporting person). */
  async routesFor(email: string): Promise<RoutesFor> { return must(await sb!.rpc('routes_for', { p_email: email })) as RoutesFor; },
  async routes(): Promise<Route[]> { const { data, error } = await sb!.rpc('pending_routes'); if (error) return []; return (data ?? []) as Route[]; },
  async leaves(): Promise<LeaveReq[]> {
    const r = must(await sb!.from('leave_requests').select('id, leave_type, starts_on, ends_on, half_day, reason, status, created_at, clarify_at, p:profiles!leave_requests_user_id_fkey(full_name, hub:hubs(name))').eq('status', 'pending').order('starts_on'));
    return (r as unknown as (LeaveReq & { p: { full_name: string; hub: { name: string } | null } })[]).map((x) => ({ ...x, who: x.p.full_name, hub: x.p.hub?.name ?? null }));
  },
  async ods(): Promise<OdReq[]> {
    const r = must(await sb!.from('od_requests').select('id, subject, note, venue_name, venue_place, venue_url, venue_lat, venue_lng, starts_at, ends_at, status, created_at, clarify_at, p:profiles!od_requests_user_id_fkey(full_name, hub:hubs(name))').eq('status', 'pending').order('starts_at'));
    return (r as unknown as (OdReq & { p: { full_name: string; hub: { name: string } | null } })[]).map((x) => ({ ...x, who: x.p.full_name, hub: x.p.hub?.name ?? null }));
  },
  /** Leave and OD decided in the last 30 days (both kinds), newest first; each opens its timeline. */
  async history(): Promise<HistoryItem[]> {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    type R = { id: string; status: string; decided_at: string; decided_route: string | null; p: { full_name: string; hub: { name: string } | null } };
    const [l, o] = await Promise.all([
      sb!.from('leave_requests').select('id, leave_type, status, decided_at, decided_route, assigned_by_hr, p:profiles!leave_requests_user_id_fkey(full_name, hub:hubs(name))').in('status', ['approved', 'returned']).eq('assigned_by_hr', false).gte('decided_at', since),
      sb!.from('od_requests').select('id, subject, status, decided_at, decided_route, p:profiles!od_requests_user_id_fkey(full_name, hub:hubs(name))').in('status', ['approved', 'returned']).gte('decided_at', since)
    ]);
    const out: HistoryItem[] = [
      ...((must(l) as unknown as (R & { leave_type: string })[]).map((x) => ({ kind: 'leave' as const, id: x.id, who: x.p.full_name, hub: x.p.hub?.name ?? null, title: `${x.leave_type[0].toUpperCase()}${x.leave_type.slice(1)} leave`, status: x.status, decided_at: x.decided_at, by: x.decided_route }))),
      ...((must(o) as unknown as (R & { subject: string })[]).map((x) => ({ kind: 'od' as const, id: x.id, who: x.p.full_name, hub: x.p.hub?.name ?? null, title: x.subject, status: x.status, decided_at: x.decided_at, by: x.decided_route })))
    ];
    return out.sort((a, b) => b.decided_at.localeCompare(a.decided_at));
  },
  async flags(): Promise<Flag[]> {
    const r = must(await sb!.from('flags')
      .select('id, kind, rule, details, status, staff_reason, created_at, user_id, punch:punches(server_time, lat, lng, accuracy_m, place_name, distance_m, quality_score, face_similarity, selfie_key, mocked, target_type, target_id, inside), p:profiles!flags_user_id_fkey(full_name, hub:hubs(name))')
      .in('status', ['open', 'reason_asked']).order('created_at', { ascending: false }).limit(100));
    return (r as unknown as (Flag & { p: { full_name: string; hub: { name: string } | null } })[])
      .filter((f) => f.kind !== 'late' || f.staff_reason || f.status === 'reason_asked')   // late shows once HR asked
      .map((f) => ({ ...f, who: f.p.full_name, hub: f.p.hub?.name ?? null }));
  },
  async pins(userId: string): Promise<Pin[]> {
    return must(await sb!.from('punches').select('server_time, lat, lng, accuracy_m').eq('user_id', userId).eq('kind', 'in').order('server_time', { ascending: false }).limit(7)) as Pin[];
  },
  /** 5-minute link to view a selfie, from S3 or Supabase Storage (the server knows which). Requests made together go as one call. */
  selfieUrl(key: string | null): Promise<string | null> { return key ? selfieLink(key) : Promise.resolve(null); },
  async hubs(): Promise<Hub[]> {
    const hs = must(await sb!.from('hubs').select('id, name, lat, lng, radius_m, maps_url, active, pin_set_at, checkin_method').order('name')) as Hub[];
    const ps = must(await sb!.from('profiles').select('hub_id').in('role', ['staff', 'intern']).eq('active', true)) as { hub_id: string | null }[];
    return hs.map((h) => ({ ...h, staff: ps.filter((p) => p.hub_id === h.id).length }));
  },
  async saveHub(h: Partial<Hub> & { name: string; lat: number; lng: number; radius_m: number }) {
    const q = h.id ? sb!.from('hubs').update({ name: h.name, lat: h.lat, lng: h.lng, radius_m: h.radius_m, maps_url: h.maps_url }).eq('id', h.id)
      : sb!.from('hubs').insert({ name: h.name, lat: h.lat, lng: h.lng, radius_m: h.radius_m, maps_url: h.maps_url });
    const { error } = await q; if (error) throw new ApiError('save_failed');
  },
  async addStaff(s: { full_name: string; email: string; role: 'staff' | 'intern'; designation: string; hub_name: string; phone?: string; joined_on?: string; employee_code?: string }) {
    const email = s.email.trim().toLowerCase();
    const { data: dup } = await sb!.from('staff_roster').select('full_name').eq('email', email).maybeSingle();
    if (dup) throw new ApiError(`already_added:${dup.full_name}`);
    if (s.employee_code) {
      const { data: dupc } = await sb!.from('staff_roster').select('full_name').eq('employee_code', s.employee_code).maybeSingle();
      if (dupc) throw new ApiError(`code_taken:${dupc.full_name}`);
    }
    const { error } = await sb!.from('staff_roster').insert({ ...s, email, employee_code: s.employee_code || null, phone: s.phone || null });
    if (error) throw new ApiError(error.code === '23505' ? 'already_added:' : 'save_failed');
  },
  /** Edit details or move to another hub. The profile follows by trigger and the person is told about a hub move. */
  async updateStaff(email: string, f: { hub_name: string; designation: string; phone: string; employee_code: string }) {
    if (f.employee_code) {
      const { data: dupc } = await sb!.from('staff_roster').select('full_name, email').eq('employee_code', f.employee_code).neq('email', email).maybeSingle();
      if (dupc) throw new ApiError(`code_taken:${dupc.full_name}`);
    }
    const { error } = await sb!.from('staff_roster').update({ hub_name: f.hub_name, designation: f.designation.trim() || null, phone: f.phone.trim() || null, employee_code: f.employee_code.trim() || null }).eq('email', email);
    if (error) throw new ApiError('save_failed');
  },
  /** Deletes the person completely (account, records, selfies). The same email can be added again afterwards. */
  async deleteStaff(email: string) {
    const { error } = await sb!.functions.invoke('check-in', { body: { action: 'delete_person', email } });
    if (error) { let code = 'save_failed'; try { code = (await (error as { context?: Response }).context?.json())?.error ?? code; } catch { /* keep */ } throw new ApiError(/role/.test(code) ? 'role_account' : code); }
  },
  async personDetail(userId: string, email?: string): Promise<PersonDetail> {
    const ist = new Date(Date.now() + 330 * 60000);
    const today = ist.toISOString().slice(0, 10), monthStart = today.slice(0, 8) + '01';
    const [punches, days, ods, leaves] = await Promise.all([
      sb!.from('punches').select('id, kind, server_time, lat, lng, place_name, band, early_out, selfie_key, distance_m, inside, accuracy_m, target_type, target_id').eq('user_id', userId).gte('server_time', new Date(`${today}T00:00:00+05:30`).toISOString()).order('server_time'),
      sb!.from('attendance_days').select('day, band, status, early_out, in_time, out_time').eq('user_id', userId).gte('day', monthStart).order('day'),
      sb!.from('od_requests').select('id, subject, venue_name, starts_at, ends_at, status').eq('user_id', userId).order('starts_at', { ascending: false }).limit(10),
      sb!.from('leave_requests').select('id, leave_type, starts_on, ends_on, status').eq('user_id', userId).order('starts_on', { ascending: false }).limit(10)
    ]);
    const ps = (punches.data ?? []) as DayPunch[];
    const ids = ps.map((x) => x.id).filter(Boolean) as string[];
    const asks = ids.length ? ((await sb!.from('flags').select('id, punch_id, kind, status, staff_reason').in('punch_id', ids).in('kind', ['late', 'early_out'])).data ?? []) : [];
    const merged = email ? await personDaysByEmail(email).catch(() => null) : null;   // HR: fingerprint days merged in
    const ex = email ? await monthExtras(email).catch(() => ({ holidays: [], marks: [] })) : { holidays: [], marks: [] };
    return { asks: asks as PersonDetail['asks'], punches: ps, days: merged ?? (days.data ?? []) as PersonDetail['days'], ods: (ods.data ?? []) as PersonDetail['ods'], leaves: (leaves.data ?? []) as PersonDetail['leaves'], ...ex };
  },
  async setActive(id: string, active: boolean) { const { error } = await sb!.from('profiles').update({ active }).eq('id', id); if (error) throw new ApiError('save_failed'); },
  async decideLeave(id: string, decision: 'approved' | 'returned', reason?: string) { const { error } = await sb!.rpc('decide_leave', { p_id: id, p_decision: decision, p_reason: reason ?? null }); if (error) throw new ApiError(error.message); },
  async decideOd(id: string, decision: 'approved' | 'returned', reason?: string) { const { error } = await sb!.rpc('decide_od', { p_id: id, p_decision: decision, p_reason: reason ?? null }); if (error) throw new ApiError(error.message); },
  async longLeave(user: string, type: string, from: string, to: string) { const { error } = await sb!.rpc('assign_long_leave', { p_user: user, p_type: type, p_from: from, p_to: to }); if (error) throw new ApiError('save_failed'); },
  async askReason(id: string) { const { error } = await sb!.rpc('ask_flag_reason', { p_flag: id }); if (error) throw new ApiError('save_failed'); },
  async presenceDay(uid: string): Promise<PresenceDay> { return must(await sb!.rpc('presence_day', { p_user: uid })) as PresenceDay; },
  async presenceToday(): Promise<PresenceNow[]> { return must(await sb!.rpc('presence_today')) as PresenceNow[]; },
  async liveLocations(): Promise<LiveRow[]> { return must(await sb!.rpc('live_locations')) as LiveRow[]; },
  async presenceBoard(day: string): Promise<PresenceRow[]> { return must(await sb!.rpc('presence_board', { p_day: day })) as PresenceRow[]; },
  async askPunchReason(punchId: string, kind: 'late' | 'early_out') { const { error } = await sb!.rpc('ask_punch_reason', { p_punch: punchId, p_kind: kind }); if (error) throw new ApiError('save_failed'); },
  async decideFlag(id: string, d: 'valid' | 'violation') { const { error } = await sb!.rpc('decide_flag', { p_flag: id, p_decision: d }); if (error) throw new ApiError('save_failed'); }
};

// ---------------- demo ----------------
const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
const D = {
  people: [
    { id: 'p1', full_name: 'Kavya R', designation: 'Project Associate', email: 'kavya@startuptn.in', role: 'staff', hub: 'Chennai', phone: '98400 10001', employee_code: 'STN0142', active: true, face_status: 'approved', today: { in_time: iso(300), out_time: null, band: 'ok', status: 'present' } },
    { id: 'p2', full_name: 'Vignesh P', designation: 'Project Lead', email: 'vignesh@startuptn.in', role: 'staff', hub: 'Trichy', phone: '98400 10002', employee_code: 'STN0117', active: true, face_status: 'approved', today: { in_time: iso(260), out_time: null, band: 'bad', status: 'present' } },
    { id: 'p3', full_name: 'Deepa V', designation: 'Project Associate', email: 'deepa@startuptn.in', role: 'staff', hub: 'Villupuram', phone: '98400 10003', employee_code: 'STN0161', active: true, face_status: 'approved', today: { in_time: iso(295), out_time: null, band: 'ok', status: 'present' } },
    { id: 'p4', full_name: 'Imran A', designation: 'Hub Lead', email: 'imran@startuptn.in', role: 'staff', hub: 'Hosur', phone: '98400 10004', employee_code: 'STN0109', active: true, face_status: 'approved', today: { in_time: iso(268), out_time: null, band: 'bad', status: 'present' } },
    { id: 'p5', full_name: 'Sneha P', designation: 'Intern', email: 'sneha.p@gmail.com', role: 'intern', hub: 'Erode', phone: null, employee_code: 'STNI021', active: true, face_status: 'pending', today: null }
  ] as Person[],
  leaves: [{ id: 'l1', who: 'Anitha R', hub: 'Salem', leave_type: 'casual', starts_on: '2026-11-12', ends_on: '2026-11-13', half_day: null, reason: 'Sister’s wedding', status: 'pending', created_at: iso(120) }] as LeaveReq[],
  ods: [{ id: 'o1', who: 'Gokul M', hub: 'Coimbatore', subject: 'Investor demo day', note: null, venue_name: 'Codissia Trade Fair Complex', venue_place: 'Avinashi Road, Peelamedu, Coimbatore', venue_url: 'https://maps.app.goo.gl/demo', venue_lat: 11.0301, venue_lng: 77.0322, starts_at: iso(-180), ends_at: iso(-360), status: 'pending', created_at: iso(60) }] as OdReq[],
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
  async people() { await wait(); return D.people.map((p) => ({ ...p, geo: p.today?.in_time ? (p.full_name.startsWith('Vignesh') ? 'out' as const : 'in' as const) : null })); },
  async leaves() { await wait(); return D.leaves; },
  async ods() { await wait(); return D.ods; },
  async history() { await wait(); return []; },
  async presenceDay(uid: string): Promise<PresenceDay> { await wait(); const t = (h: number, m: number) => { const d = new Date(); d.setUTCHours(h - 5, m - 30, 0, 0); return d.toISOString(); };
    return uid.endsWith('1') ? { tracked: true, from: t(10, 2), to: t(16, 30), inside_min: 312, outside_min: 48, od_min: 0, no_signal_min: 28, samples: 90, trips: [{ from: t(11, 40), to: t(12, 5), min: 25, max_m: 640 }, { from: t(15, 10), to: t(15, 33), min: 23, max_m: 1300 }] } : { tracked: false, inside_min: 0, outside_min: 0, od_min: 0, no_signal_min: 0, trips: [], samples: 0 }; },
  async presenceToday() { await wait(); return []; },
  async liveLocations(): Promise<LiveRow[]> { await wait(); const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    return [{ user_id: 'u1', full_name: 'Kavya R', hub: 'Chennai', lat: 13.0108, lng: 80.2206, accuracy_m: 12, at: ago(2), inside: true, target_type: 'hub', state: 'inside', checked_in: true },
      { user_id: 'u2', full_name: 'Arun K', hub: 'Chennai', lat: 13.0412, lng: 80.2337, accuracy_m: 20, at: ago(4), inside: false, target_type: 'hub', state: 'outside', checked_in: true },
      { user_id: 'u3', full_name: 'Meena S', hub: 'Chennai', lat: 13.0067, lng: 80.2571, accuracy_m: 35, at: ago(41), inside: true, target_type: 'hub', state: 'no_signal', checked_in: true }]; },
  async presenceBoard(): Promise<PresenceRow[]> { await wait(); return [{ user_id: 'u2', full_name: 'Arun K', hub: 'Chennai', inside_min: 300, outside_min: 95, od_min: 0, no_signal_min: 0, trips: 2, longest_trip: 70, last_at: null, last_inside: false, tracked: true, samples: 120 },
      { user_id: 'u3', full_name: 'Meena S', hub: 'Chennai', inside_min: 340, outside_min: 0, od_min: 0, no_signal_min: 45, trips: 0, longest_trip: 0, last_at: null, last_inside: true, tracked: true, samples: 80 },
      { user_id: 'u1', full_name: 'Kavya R', hub: 'Chennai', inside_min: 410, outside_min: 0, od_min: 0, no_signal_min: 0, trips: 0, longest_trip: 0, last_at: null, last_inside: true, tracked: true, samples: 140 }]; },
  async askPunchReason() { await wait(); },
  async flags() { await wait(); return D.flags; },
  async pins(uid) {
    await wait();
    const same = uid === 'p3';
    return Array.from({ length: 7 }, (_, i) => ({ server_time: iso(295 + i * 1440), lat: same ? 11.93941 : 11.9394 + (i % 3) * 0.00011, lng: same ? 79.48623 : 79.4862 + (i % 2) * 0.00009, accuracy_m: same ? 5 : 9 + i * 3 }));
  },
  async selfieUrl() { return null; },
  async hubs() { await wait(); return D.hubs; },
  async saveHub(h) { await wait(); const i = D.hubs.findIndex((x) => x.id === h.id); if (i >= 0) D.hubs[i] = { ...D.hubs[i], ...h }; else D.hubs.push({ ...h, id: crypto.randomUUID(), active: true, maps_url: h.maps_url ?? null, staff: 0 }); },
  async addStaff(s) { await wait(); const dup = D.people.find((x) => x.email === s.email.trim().toLowerCase()); if (dup) throw new ApiError(`already_added:${dup.full_name}`); D.people.push({ id: crypto.randomUUID(), full_name: s.full_name, email: s.email, role: s.role, designation: s.designation, hub: s.hub_name, phone: s.phone ?? null, employee_code: s.employee_code ?? null, active: true, face_status: 'none', invited: true, today: null }); },
  async updateStaff(email, f) { await wait(); const p = D.people.find((x) => x.email === email); if (p) Object.assign(p, { hub: f.hub_name, designation: f.designation || null, phone: f.phone || null, employee_code: f.employee_code || null }); },
  async deleteStaff(email) { await wait(); D.people = D.people.filter((x) => x.email !== email); },
  async personDays() { await wait(); return []; },
  async monthExtras() { await wait(); return { holidays: [], marks: [] }; },
  async holidays() { await wait(); return [{ day: '2026-11-08', name: 'Deepavali', kind: 'govt' as const }, { day: '2026-12-25', name: 'Christmas', kind: 'govt' as const }]; },
  async saveHoliday() { await wait(); },
  async deleteHoliday() { await wait(); },
  async markOf() { await wait(); return null; },
  async setDayMark() { await wait(); },
  async setReportsTo() { await wait(); },
  async setApprover() { await wait(); },
  async routes() { await wait(); return []; },
  async rosterLite() { await wait(); return D.people.map((x) => ({ email: x.email, full_name: x.full_name, hub: x.hub, invited: !!x.invited })); },
  async personMonth(_e: string, month: string) { return api.myMonth(month); },
  async setStaffApprover() { await wait(); },
  async markQueries() { await wait(); return []; },
  async routesFor() { await wait(); return { leave: { route: 'hr', name: 'HR', set: null }, od: { route: 'chairman', name: 'Chairman', set: null }, default_leave: 'hr', default_od: 'chairman', reports_to: null, reports_to_name: null, reports_to_signed_in: false }; },
  async personDetail(uid) {
    await wait();
    const p = D.people.find((x) => x.id === uid);
    const ist = new Date(Date.now() + 330 * 60000); const ym = ist.toISOString().slice(0, 8); const dnow = ist.getUTCDate();
    const bands = ['ok', 'ok', 'warn', 'ok', 'ok', 'bad', 'ok'];
    const days = Array.from({ length: dnow - 1 }, (_, i) => i + 1).filter((d) => new Date(`${ym}${String(d).padStart(2, '0')}`).getUTCDay() % 6 !== 0)
      .map((d, i) => ({ day: `${ym}${String(d).padStart(2, '0')}`, band: i === 4 ? null : bands[i % 7], status: i === 4 ? 'od' : i === 9 ? 'absent' : 'present', early_out: i === 6, in_time: null, out_time: null }));
    const punches = p?.today?.in_time ? [{ id: `pin-${uid}`, kind: 'in' as const, server_time: p.today.in_time, lat: 13.0108, lng: 80.2206, place_name: 'Guindy, Chennai', band: p.today.band, early_out: false, selfie_key: null, distance_m: 40 }] : [];
    return { punches, days, ods: [{ id: 'o9', subject: 'TIDCO policy meet', venue_name: 'Guindy, Chennai', starts_at: iso(-2880), ends_at: iso(-3000), status: 'approved' }, { id: 'o8', subject: 'Startup expo', venue_name: 'Codissia, Coimbatore', starts_at: iso(8000), ends_at: iso(7700), status: 'approved' }],
      leaves: [{ id: 'l9', leave_type: 'casual', starts_on: `${ym}03`, ends_on: `${ym}03`, status: 'approved' }] };
  },
  async setActive(id, active) { await wait(); const p = D.people.find((x) => x.id === id); if (p) p.active = active; },
  async decideLeave(id) { await wait(); D.leaves = D.leaves.filter((x) => x.id !== id); },
  async decideOd(id) { await wait(); D.ods = D.ods.filter((x) => x.id !== id); },
  async longLeave() { await wait(); },
  async askReason(id) { await wait(); const f = D.flags.find((x) => x.id === id); if (f) f.status = 'reason_asked'; },
  async decideFlag(id) { await wait(); D.flags = D.flags.filter((x) => x.id !== id); }
};

export const hr = DEMO ? demo : real;

export const FLAG_LABEL: Record<string, [string, string]> = {
  location_changer: ['Location changer', 'c-bad'], mock_location: ['Mock location', 'c-bad'], radius: ['Outside radius', 'c-bad'], radius_edge: ['Edge of radius', 'c-warn'], away: ['Away from hub', 'c-bad'],
  face: ['Face mismatch', 'c-bad'], liveness: ['Liveness', 'c-warn'], device: ['Device', 'c-bad'], jump: ['Impossible jump', 'c-bad'],
  clock: ['Phone clock', 'c-warn'], offline: ['Synced late', 'c-warn'], late: ['Late', 'c-warn'], early_out: ['Early out', 'c-warn']
};
