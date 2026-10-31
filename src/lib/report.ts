// Attendance report for Tech admin (and later HR): one Excel file with Summary, Attendance (person x day),
// OD (approval, timings, venue, map) and Flags (every check signal). Filters: everyone, one hub, or one person.
import { sb, DEMO, ApiError } from './api';
import { fetchAll, type Q } from './fetchAll';
import { FLAG_LABEL } from './hr';
import { writeXlsx, type Cell, type Sheet } from './xlsx';

export interface ReportArgs { scope: 'all' | 'hub' | 'person'; hub?: string | null; userId?: string | null; from: string; to: string }

const IST = 330 * 60000;
const istDate = (iso: string) => new Date(new Date(iso).getTime() + IST).toISOString().slice(0, 10);
const istTime = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() + IST).toISOString().slice(11, 16) : '');
const istDT = (iso: string | null | undefined) => (iso ? `${istDate(iso)} ${istTime(iso)}` : '');
const map = (lat: number | null | undefined, lng: number | null | undefined): Cell => (lat != null && lng != null ? { link: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, text: `${lat.toFixed(5)}, ${lng.toFixed(5)}` } : '');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const label = (k: string) => (FLAG_LABEL[k] ?? [k.replace(/_/g, ' ')])[0];
const flagStatus = (f: { status: string; details: Record<string, unknown> | null }) => (f.details?.false_flag_at ? 'False flag' : ({ open: 'Open', reason_asked: 'Reason asked', valid: 'Cleared', violation: 'Violation' } as Record<string, string>)[f.status] ?? f.status);

type P = { id: string; full_name: string; email: string; employee_code: string | null; designation: string | null; hub: { name: string } | null };
type D = { user_id: string; day: string; in_time: string | null; out_time: string | null; band: string | null; early_out: boolean; status: string; in_punch: string | null; out_punch: string | null; leave_od_id: string | null };
type Pu = { id: string; user_id: string; kind: string; server_time: string; lat: number; lng: number; accuracy_m: number | null; place_name: string | null; inside: boolean | null; distance_m: number | null; target_type: string; target_id: string | null; status: string; quality_score: number | null; face_similarity: number | null };
type O = { id: string; user_id: string; subject: string; venue_name: string; venue_place: string | null; venue_url: string | null; venue_lat: number | null; venue_lng: number | null; starts_at: string; ends_at: string; status: string; decided_role: string | null; decided_at: string | null; return_reason: string | null; created_at: string };
type L = { user_id: string; leave_type: string; starts_on: string; ends_on: string; status: string };
type F = { id: string; user_id: string; kind: string; rule: string; status: string; staff_reason: string | null; created_at: string; details: Record<string, unknown> | null; punch: { lat: number; lng: number; place_name: string | null; distance_m: number | null; accuracy_m: number | null; face_similarity: number | null; mocked: boolean | null } | null };

export async function load(a: ReportArgs) {
  const fromIso = new Date(`${a.from}T00:00:00+05:30`).toISOString(), toIso = new Date(`${a.to}T23:59:59+05:30`).toISOString();
  const [ps, tests] = await Promise.all([
    fetchAll<P>(() => sb!.from('profiles').select('id, full_name, email, employee_code, designation, hub:hubs(name)').in('role', ['staff', 'intern']).order('full_name').order('id')),
    sb!.from('staff_roster').select('email').eq('is_test', true)
  ]);
  const testSet = new Set(((tests.data ?? []) as { email: string }[]).map((t) => t.email));
  const people = ps.filter((p) => (a.scope === 'person' ? p.id === a.userId : !testSet.has(p.email) && (a.scope === 'all' || p.hub?.name === a.hub)));
  const ids = people.map((p) => p.id);
  if (!ids.length) return { people, days: [] as D[], punches: [] as Pu[], ods: [] as O[], leaves: [] as L[], flags: [] as F[] };
  const chunks: string[][] = []; for (let i = 0; i < ids.length; i += 80) chunks.push(ids.slice(i, i + 80));
  const all = async <T,>(mk: (c: string[]) => () => Q) => (await Promise.all(chunks.map((c) => fetchAll<T>(mk(c))))).flat();
  const [days, punches, ods, leaves, flags] = await Promise.all([
    all<D>((c) => () => sb!.from('attendance_days').select('user_id, day, in_time, out_time, band, early_out, status, in_punch, out_punch, leave_od_id').in('user_id', c).gte('day', a.from).lte('day', a.to).order('day').order('user_id')),
    all<Pu>((c) => () => sb!.from('punches').select('id, user_id, kind, server_time, lat, lng, accuracy_m, place_name, inside, distance_m, target_type, target_id, status, quality_score, face_similarity').in('user_id', c).gte('server_time', fromIso).lte('server_time', toIso).order('server_time').order('id')),
    all<O>((c) => () => sb!.from('od_requests').select('id, user_id, subject, venue_name, venue_place, venue_url, venue_lat, venue_lng, starts_at, ends_at, status, decided_role, decided_at, return_reason, created_at').in('user_id', c).lte('starts_at', toIso).gte('ends_at', fromIso).order('starts_at').order('id')),
    all<L>((c) => () => sb!.from('leave_requests').select('user_id, leave_type, starts_on, ends_on, status').in('user_id', c).eq('status', 'approved').lte('starts_on', a.to).gte('ends_on', a.from).order('starts_on').order('user_id')),
    all<F>((c) => () => sb!.from('flags').select('id, user_id, kind, rule, status, staff_reason, created_at, details, punch:punches(lat, lng, place_name, distance_m, accuracy_m, face_similarity, mocked)').in('user_id', c).gte('created_at', fromIso).lte('created_at', toIso).order('created_at').order('id'))
  ]);
  return { people, days, punches, ods, leaves, flags };
}

export async function buildReport(a: ReportArgs): Promise<{ blob: Blob; name: string; counts: { people: number; days: number; ods: number; flags: number }; sheets?: Sheet[] }> {
  if (DEMO) return demoReport(a);
  const span = (new Date(a.to).getTime() - new Date(a.from).getTime()) / 864e5;
  if (!(span >= 0) || span > 92) throw new ApiError('range_too_long');
  const data = await load(a);
  void sb!.rpc('log_action', { p_action: 'export', p_entity: 'attendance_report', p_entity_id: `${a.scope}:${a.hub ?? a.userId ?? 'all'}:${a.from}..${a.to}`, p_details: { people: data.people.length } });
  return assemble(a, data);
}

/** Pure: turns loaded rows into the four sheets (tested on its own). */
export function assemble(a: ReportArgs, { people, days, punches, ods, leaves, flags }: Awaited<ReturnType<typeof load>>) {

  const byId = new Map(people.map((p) => [p.id, p]));
  const pun = new Map(punches.map((p) => [p.id, p]));
  const dayKey = (u: string, d: string) => `${u}|${d}`;
  const dmap = new Map(days.map((d) => [dayKey(d.user_id, d.day), d]));
  const visits = new Map<string, Pu>(); for (const p of punches) if (p.target_type === 'od' && p.target_id && !visits.has(p.target_id)) visits.set(p.target_id, p);
  const flagsByDay = new Map<string, F[]>(); for (const f of flags) { const k = dayKey(f.user_id, istDate(f.created_at)); flagsByDay.set(k, [...(flagsByDay.get(k) ?? []), f]); }
  const decided = (o: O) => (o.status === 'approved' ? `Approved by ${o.decided_role === 'hr' ? 'HR' : 'Chairman'}` : o.status === 'returned' ? `Returned by ${o.decided_role === 'hr' ? 'HR' : 'Chairman'}` : o.status === 'pending' ? 'Waiting' : 'Cancelled');
  const hubOf = (u: string) => byId.get(u)?.hub?.name ?? '';

  // dates in range
  const dates: string[] = []; for (let t = new Date(`${a.from}T00:00:00Z`).getTime(); t <= new Date(`${a.to}T00:00:00Z`).getTime(); t += 864e5) dates.push(new Date(t).toISOString().slice(0, 10));

  const att: Cell[][] = [['Date', 'Day', 'Code', 'Name', 'Email', 'Hub', 'Designation', 'Status', 'Check-in', 'In place', 'In map', 'In radius', 'In distance (m)', 'On time',
    'Check-out', 'Out place', 'Out map', 'Out radius', 'Early out', 'Hours', 'OD', 'OD venue', 'OD time', 'OD approval', 'Venue check-in', 'Leave', 'Flags', 'In review']];
  const sum = new Map<string, { present: number; ontime: number; late: number; early: number; od: number; leave: number; notin: number; flags: number; outside: number }>();
  for (const p of people) sum.set(p.id, { present: 0, ontime: 0, late: 0, early: 0, od: 0, leave: 0, notin: 0, flags: 0, outside: 0 });
  for (const date of dates) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const p of people) {
      const d = dmap.get(dayKey(p.id, date)), s = sum.get(p.id)!;
      const inP = d?.in_punch ? pun.get(d.in_punch) : undefined, outP = d?.out_punch ? pun.get(d.out_punch) : undefined;
      const od = ods.find((o) => o.user_id === p.id && o.status !== 'cancelled' && istDate(o.starts_at) <= date && istDate(o.ends_at) >= date);
      const lv = leaves.find((l) => l.user_id === p.id && l.starts_on <= date && l.ends_on >= date);
      const fl = flagsByDay.get(dayKey(p.id, date)) ?? [];
      const visit = od ? visits.get(od.id) : undefined;
      const status = d?.in_time ? (d.status === 'od' ? 'OD (checked in at venue)' : 'Present') : lv ? 'Leave' : od?.status === 'approved' ? 'OD' : dow === 0 ? 'Sunday' : 'Not in';
      if (d?.in_time) { s.present++; if (d.band === 'ok') s.ontime++; else if (d.band) s.late++; }
      if (d?.early_out) s.early++; if (od?.status === 'approved') s.od++; if (lv) s.leave++; if (status === 'Not in') s.notin++;
      s.flags += fl.length; if (inP?.inside === false || outP?.inside === false) s.outside++;
      const hrs = d?.in_time && d?.out_time ? Math.round(((new Date(d.out_time).getTime() - new Date(d.in_time).getTime()) / 3.6e6) * 10) / 10 : '';
      att.push([date, DAYS[dow], p.employee_code ?? '', p.full_name, p.email, p.hub?.name ?? '', p.designation ?? '', status,
        istTime(d?.in_time), inP?.place_name ?? '', map(inP?.lat, inP?.lng), inP ? (inP.inside === false ? 'Outside' : inP.inside ? 'Inside' : '') : '', inP?.distance_m ?? '',
        d?.band ? ({ ok: 'On time', warn: 'Slightly late', bad: 'Late' } as Record<string, string>)[d.band] : '',
        istTime(d?.out_time), outP?.place_name ?? '', map(outP?.lat, outP?.lng), outP ? (outP.inside === false ? 'Outside' : outP.inside ? 'Inside' : '') : '',
        d?.out_time ? (d.leave_od_id ? 'No (left for OD)' : d.early_out ? 'Yes' : 'No') : '', hrs,
        od?.subject ?? '', od ? `${od.venue_name}${od.venue_place ? ` · ${od.venue_place}` : ''}` : '', od ? `${istTime(od.starts_at)}–${istTime(od.ends_at)}` : '', od ? decided(od) : '',
        visit ? `${istTime(visit.server_time)} · ${visit.inside === false ? 'Outside venue' : 'At venue'}` : od?.status === 'approved' ? 'Not done' : '',
        lv ? lv.leave_type : '', fl.map((f) => `${label(f.kind)} (${flagStatus(f)})`).join('; '), [inP, outP].some((x) => x?.status === 'review') ? 'Yes' : '']);
    }
  }

  const odRows: Cell[][] = [['Name', 'Code', 'Hub', 'Subject', 'Venue', 'Venue place', 'Venue map', 'Maps link given', 'From', 'To', 'Hours', 'Requested', 'Notice (h)', 'Status', 'Decided', 'Decided at', 'Reply time (h)', 'Return reason', 'Venue check-in', 'Venue radius', 'Venue distance (m)']];
  for (const o of ods) {
    const p = byId.get(o.user_id), v = visits.get(o.id);
    odRows.push([p?.full_name ?? '', p?.employee_code ?? '', hubOf(o.user_id), o.subject, o.venue_name, o.venue_place ?? '', map(o.venue_lat, o.venue_lng), o.venue_url ? { link: o.venue_url, text: 'Open' } : '',
      istDT(o.starts_at), istDT(o.ends_at), Math.round(((new Date(o.ends_at).getTime() - new Date(o.starts_at).getTime()) / 3.6e6) * 10) / 10,
      istDT(o.created_at), Math.round((new Date(o.starts_at).getTime() - new Date(o.created_at).getTime()) / 3.6e6), decided(o).split(' by ')[0], o.decided_role === 'hr' ? 'HR' : o.decided_role === 'chairman' ? 'Chairman' : '',
      istDT(o.decided_at), o.decided_at ? Math.round(((new Date(o.decided_at).getTime() - new Date(o.created_at).getTime()) / 3.6e6) * 10) / 10 : '', o.return_reason ?? '',
      v ? istDT(v.server_time) : '', v ? (v.inside === false ? 'Outside' : 'Inside') : '', v?.distance_m ?? '']);
  }

  const flRows: Cell[][] = [['Date', 'Time', 'Name', 'Code', 'Hub', 'Signal', 'Rule', 'Status', 'Staff reason', 'Place', 'Map', 'Distance (m)', 'GPS accuracy (m)', 'Face match %', 'Mock location']];
  for (const f of flags) {
    const p = byId.get(f.user_id), pu = f.punch;
    flRows.push([istDate(f.created_at), istTime(f.created_at), p?.full_name ?? '', p?.employee_code ?? '', hubOf(f.user_id), label(f.kind), f.rule, flagStatus(f), f.staff_reason ?? '',
      pu?.place_name ?? '', map(pu?.lat, pu?.lng), pu?.distance_m ?? '', pu?.accuracy_m != null ? Math.round(pu.accuracy_m) : '', pu?.face_similarity != null ? Math.round(pu.face_similarity) : '', pu?.mocked ? 'Yes' : '']);
  }

  const sumRows: Cell[][] = [['Name', 'Code', 'Hub', 'Designation', 'Present', 'On time', 'Late', 'Early out', 'OD days', 'Leave days', 'Not in', 'Flags', 'Outside radius']];
  for (const p of people) { const s = sum.get(p.id)!; sumRows.push([p.full_name, p.employee_code ?? '', p.hub?.name ?? '', p.designation ?? '', s.present, s.ontime, s.late, s.early, s.od, s.leave, s.notin, s.flags, s.outside]); }

  const sheets: Sheet[] = [
    { name: 'Summary', rows: sumRows, widths: [24, 12, 14, 22, 9, 9, 7, 10, 9, 10, 8, 7, 14] },
    { name: 'Attendance', rows: att, widths: [11, 6, 10, 22, 26, 12, 18, 18, 9, 28, 22, 10, 12, 12, 9, 28, 22, 10, 16, 7, 22, 30, 12, 20, 20, 10, 36, 9] },
    { name: 'OD', rows: odRows, widths: [22, 10, 12, 26, 24, 30, 22, 10, 16, 16, 7, 16, 9, 10, 10, 16, 10, 22, 16, 10, 12] },
    { name: 'Flags', rows: flRows, widths: [11, 7, 22, 10, 12, 18, 30, 12, 30, 28, 22, 11, 12, 11, 10] }
  ];
  const tag = a.scope === 'all' ? 'all-staff' : a.scope === 'hub' ? `${(a.hub ?? 'hub').toLowerCase()}-hub` : (people[0]?.full_name ?? 'person').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { blob: writeXlsx(sheets), sheets, name: `stn-attendance-${tag}-${a.from}-to-${a.to}.xlsx`, counts: { people: people.length, days: dates.length, ods: ods.length, flags: flags.length } };
}

function demoReport(a: ReportArgs) {
  const rows: Cell[][] = [['Date', 'Name', 'Hub', 'Status', 'Check-in', 'In map', 'In radius', 'Check-out', 'OD', 'OD approval', 'Flags'],
    [a.from, 'Kavya R', 'Chennai', 'Present', '09:52', map(13.0318, 80.2433), 'Inside', '18:05', '', '', ''],
    [a.from, 'Vignesh P', 'Trichy', 'Present', '10:32', map(10.8064, 78.6851), 'Outside', '17:40', '', '', 'Outside radius (Reason asked)'],
    [a.from, 'Gokul M', 'Coimbatore', 'OD (checked in at venue)', '11:47', map(11.0301, 77.0322), 'Inside', '', 'Investor demo day', 'Approved by Chairman', '']];
  return Promise.resolve({ blob: writeXlsx([{ name: 'Attendance', rows, widths: [11, 20, 12, 22, 9, 22, 10, 9, 20, 20, 30] }]), name: `stn-attendance-demo-${a.from}-to-${a.to}.xlsx`, counts: { people: 3, days: 1, ods: 1, flags: 1 } });
}
