// Biometric (eSSL eTimeTrackLite) link: data for the Tech admin setup screen and the HR views.
// The sync PC posts to the bio-sync function; here we only read (RLS: HR, Chairman, Tech) and call the
// Tech/HR RPCs (new key, device hub, person match). Fingerprint punches are shown as evidence only.
import { sb, DEMO, ApiError } from './api';

export interface BioLink { id: string; name: string; createdAt: string; lastSeen: string | null; info: { pc?: string; version?: string; last_punch?: string | null; last_error?: string | null; last_ok?: string | null } }
export interface BioDevice { linkId: string; esslId: number; name: string; serial: string | null; kind: 'biometric' | 'mobile' | 'manual'; hubId: string | null; lastPing: string | null }
export interface BioPerson { linkId: string; code: string; esslCode: string | null; esslName: string | null; email: string | null; matched: 'auto' | 'manual' | 'none' }
export interface RosterRow { email: string; name: string; code: string | null; hub: string | null }
export interface BioOverview { link: BioLink | null; devices: BioDevice[]; people: BioPerson[]; roster: RosterRow[]; hubs: { id: string; name: string }[]; today: number }
export interface BioPunch { at: string; direction: string | null; device: string | null; hub: string | null; code: string; esslName: string | null; email: string | null; name: string | null; userId: string | null }

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const rpcErr = (e: { message?: string } | null) => { if (e) throw new ApiError((e.message ?? 'save_failed').replace(/^.*?:\s*/, '')); };
const must = <T,>(r: { data: T | null; error: unknown }): T => { if (r.error) throw new ApiError('load_failed'); return r.data as T; };

/** Seconds since the sync PC last reported, or null if it never did. */
export const bioAge = (l: BioLink | null) => (l?.lastSeen ? Math.max(0, Math.round((Date.now() - new Date(l.lastSeen).getTime()) / 1000)) : null);
/** 'ok' when it reported in the last 2 minutes, 'warn' up to 10, 'bad' after that or never. */
export const bioState = (l: BioLink | null): 'ok' | 'warn' | 'bad' => { const a = bioAge(l); return a == null ? 'bad' : a <= 120 ? 'ok' : a <= 600 ? 'warn' : 'bad'; };

/** A likely staff member for an unmatched eSSL code: same number (016 = STN016) or the same name. */
export function suggest(p: BioPerson, roster: RosterRow[], taken: Set<string>): RosterRow | null {
  const free = roster.filter((r) => !taken.has(r.email));
  const num = (s: string | null) => { const m = (s ?? '').match(/(\d+)\s*$/); return m ? String(Number(m[1])) : null; };
  const n = num(p.esslCode) ?? num(p.code);
  const byNum = n ? free.filter((r) => num(r.code) === n) : [];
  if (byNum.length === 1) return byNum[0];
  const nm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const pw = nm(p.esslName);
  if (!pw.length) return null;
  const byName = free.filter((r) => { const rw = nm(r.name); return rw[0] === pw[0] && (pw.length < 2 || rw.some((w) => pw.slice(1).includes(w) || pw.slice(1).some((x) => x[0] === w[0]))); });
  return byName.length === 1 ? byName[0] : null;
}

const real = {
  async overview(): Promise<BioOverview> {
    const [ln, st, dv, pp, ro, hb, td] = await Promise.all([
      sb!.from('bio_links').select('id, name, created_at').is('revoked_at', null).order('created_at', { ascending: false }).limit(1),
      sb!.from('bio_status').select('link_id, last_seen, info'),
      sb!.from('bio_devices').select('link_id, essl_id, name, serial, kind, hub_id, last_ping').order('essl_id'),
      sb!.from('bio_people').select('link_id, device_code, essl_code, essl_name, email, matched').order('essl_name'),
      sb!.from('staff_roster').select('email, full_name, employee_code, hub_name').order('full_name'),
      sb!.from('hubs').select('id, name').eq('active', true).order('name'),
      sb!.from('bio_punches').select('id', { count: 'exact', head: true }).gte('punched_at', `${istToday()}T00:00:00+05:30`)
    ]);
    const l = (must(ln) as { id: string; name: string; created_at: string }[])[0];
    const s = (must(st) as { link_id: string; last_seen: string; info: BioLink['info'] }[]).find((x) => x.link_id === l?.id);
    return {
      link: l ? { id: l.id, name: l.name, createdAt: l.created_at, lastSeen: s?.last_seen ?? null, info: s?.info ?? {} } : null,
      devices: (must(dv) as { link_id: string; essl_id: number; name: string; serial: string | null; kind: BioDevice['kind']; hub_id: string | null; last_ping: string | null }[])
        .filter((d) => d.link_id === l?.id).map((d) => ({ linkId: d.link_id, esslId: d.essl_id, name: d.name, serial: d.serial, kind: d.kind, hubId: d.hub_id, lastPing: d.last_ping })),
      people: (must(pp) as { link_id: string; device_code: string; essl_code: string | null; essl_name: string | null; email: string | null; matched: BioPerson['matched'] }[])
        .filter((p) => p.link_id === l?.id).map((p) => ({ linkId: p.link_id, code: p.device_code, esslCode: p.essl_code, esslName: p.essl_name, email: p.email, matched: p.matched })),
      roster: (must(ro) as { email: string; full_name: string; employee_code: string | null; hub_name: string | null }[]).map((r) => ({ email: r.email, name: r.full_name, code: r.employee_code, hub: r.hub_name })),
      hubs: must(hb) as { id: string; name: string }[],
      today: td.count ?? 0
    };
  },
  async newKey(name = 'Chennai office'): Promise<string> { const { data, error } = await sb!.rpc('bio_new_key', { p_name: name }); rpcErr(error); return data as string; },
  async setHub(link: string, device: number, hub: string | null) { const { error } = await sb!.rpc('bio_set_device_hub', { p_link: link, p_device: device, p_hub: hub }); rpcErr(error); },
  async match(link: string, code: string, email: string | null) { const { error } = await sb!.rpc('bio_match_person', { p_link: link, p_device_code: code, p_email: email }); rpcErr(error); },
  async day(day = istToday()): Promise<BioPunch[]> {
    const { data, error } = await sb!.rpc('bio_day', { p_day: day }); rpcErr(error);
    return ((data ?? []) as { punched_at: string; direction: string | null; device: string | null; hub: string | null; device_code: string; essl_name: string | null; email: string | null; full_name: string | null; user_id: string | null }[])
      .map((r) => ({ at: r.punched_at, direction: r.direction, device: r.device, hub: r.hub, code: r.device_code, esslName: r.essl_name, email: r.email, name: r.full_name, userId: r.user_id }));
  },
  async person(userId: string, days = 7): Promise<{ at: string; direction: string | null; device: string | null }[]> {
    const { data, error } = await sb!.rpc('bio_person', { p_user: userId, p_days: days }); rpcErr(error);
    return ((data ?? []) as { punched_at: string; direction: string | null; device: string | null }[]).map((r) => ({ at: r.punched_at, direction: r.direction, device: r.device }));
  }
};

// ---------------- demo (no backend) ----------------
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const D = {
  link: { id: 'L1', name: 'Chennai office', createdAt: ago(600), lastSeen: ago(0.3), info: { pc: 'DESKTOP-CITDAJ3', version: '1.0.0', last_punch: ago(4), last_error: null, last_ok: ago(0.3) } } as BioLink | null,
  devices: [{ linkId: 'L1', esslId: 14, name: 'Biometric', serial: 'TDBD241800565', kind: 'biometric', hubId: 'h-chennai', lastPing: ago(1) },
            { linkId: 'L1', esslId: 1, name: 'Manual Entry(Attendance)', serial: null, kind: 'manual', hubId: null, lastPing: null }] as BioDevice[],
  people: [{ linkId: 'L1', code: '56', esslCode: 'STN056', esslName: 'Kavya R', email: 'kavya@startuptn.in', matched: 'auto' },
           { linkId: 'L1', code: '16', esslCode: '016', esslName: 'Arun K', email: null, matched: 'none' },
           { linkId: 'L1', code: '61', esslCode: 'tem061', esslName: 'Temp Staff', email: null, matched: 'none' }] as BioPerson[]
};
const demo: typeof real = {
  async overview() { await wait(); return { link: D.link, devices: D.devices, people: D.people, roster: [{ email: 'kavya@startuptn.in', name: 'Kavya R', code: 'STN056', hub: 'Chennai' }, { email: 'arun@startuptn.in', name: 'Arun K', code: 'STN016', hub: 'Chennai' }], hubs: [{ id: 'h-chennai', name: 'Chennai' }, { id: 'h-salem', name: 'Salem' }], today: 41 }; },
  async newKey(name = 'Chennai office') { await wait(); D.link = { id: 'L1', name, createdAt: new Date().toISOString(), lastSeen: null, info: {} }; return 'stnbio_' + '0'.repeat(64); },
  async setHub(_l, device, hub) { await wait(); D.devices = D.devices.map((d) => (d.esslId === device ? { ...d, hubId: hub } : d)); },
  async match(_l, code, email) { await wait(); D.people = D.people.map((p) => (p.code === code ? { ...p, email, matched: email ? 'manual' : 'none' } : p)); },
  async day() { await wait(); return [{ at: ago(4), direction: 'in', device: 'Biometric', hub: 'Chennai', code: '56', esslName: 'Kavya R', email: 'kavya@startuptn.in', name: 'Kavya R', userId: 's1' }, { at: ago(31), direction: 'in', device: 'Biometric', hub: 'Chennai', code: '16', esslName: 'Arun K', email: null, name: 'Arun K', userId: null }]; },
  async person() { await wait(); return [{ at: ago(4), direction: 'in', device: 'Biometric' }, { at: ago(24 * 60 - 480), direction: 'out', device: 'Biometric' }]; }
};
export const bio = DEMO ? demo : real;
