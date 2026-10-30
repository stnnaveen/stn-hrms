import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App';
import { ApiError } from '../../lib/api';
import { tech, phoneName, type Accuracy, type AuditRow, type Devices, type Device, type Health, type Overview, type RoleLogin, type Roles, type Settings } from '../../lib/tech';
import { hr, FLAG_LABEL, type Flag } from '../../lib/hr';
import { placeLabel, googleMapsUrl, appleMapsUrl, fmtDistance } from '../../lib/geo';
import { fmtDay, fmtShortDay, fmtTime, greeting } from '../../lib/time';
import { Icon } from '../../ui/Icon';
import { AccountSheet } from '../../ui/AccountSheet';
import { Notifications } from '../Notifications';
import { firstViewToday } from '../../device';

type Tab = 'home' | 'audit' | 'alerts' | 'accuracy' | 'setup';
type Sub = { name: 'roles' } | { name: 'devices' } | { name: 'rules' } | { name: 'integrations' } | { name: 'alert'; f: Flag } | { name: 'notifs' };
type Sheet = null | { t: 'account' } | { t: 'entry'; e: AuditRow } | { t: 'addlogin' } | { t: 'login'; l: RoleLogin } | { t: 'rule'; k: string; v: string }
  | { t: 'device'; d: Device } | { t: 'exports' } | { t: 'privacy' };

const TINTS = ['#3B4A6B', '#5B4AA8', '#2F62D9', '#1F7A55', '#9C3F5A', '#7A5A2E', '#4E5464'];
const tint = (s: string) => TINTS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
const ini = (n: string) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const Av = ({ n }: { n: string }) => <span className="av sm" style={{ background: tint(n), color: '#fff' }} aria-hidden="true">{ini(n)}</span>;
const ROLE_AB: Record<string, [string, string]> = { chairman: ['CH', '#0B1220'], hr: ['HR', '#9C3F5A'], tech: ['AI', '#2F62D9'], system: ['SY', '#4E5464'] };
const RoleAb = ({ role, name }: { role: string; name?: string }) => { const [l, c] = ROLE_AB[role] ?? [ini(name ?? role), '#1F7A55']; return <span className="ab" style={{ background: c }} aria-hidden="true">{l}</span>; };
const ROLE_NAME: Record<string, string> = { hr: 'HR', chairman: 'Chairman', tech: 'Tech admin', staff: 'Staff', intern: 'Intern', system: 'System' };
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const Spin = () => <div className="center" style={{ height: 200 }}><span className="spin dark" /></div>;
const flagName = (k: string) => (FLAG_LABEL[k] ?? [cap(k.replace(/_/g, ' '))])[0];

const RULES: { k: string; l: string; s: string; u: string; type: 'time' | 'number'; min?: number; max?: number }[] = [
  { k: 'office_start', l: 'On time until', s: 'Check-in by this time', u: '', type: 'time' },
  { k: 'late_until', l: 'Late until', s: 'After this it is very late', u: '', type: 'time' },
  { k: 'office_end', l: 'Office ends', s: 'Checkout before this is early out', u: '', type: 'time' },
  { k: 'face_threshold', l: 'Face match', s: 'Below this goes to review', u: '%', type: 'number', min: 50, max: 99 },
  { k: 'same_point_days', l: 'Location changer', s: 'Same exact spot this many days', u: 'days', type: 'number', min: 2, max: 30 },
  { k: 'jump_kmh', l: 'Impossible jump', s: 'Faster than this between check-ins', u: 'km/h', type: 'number', min: 60, max: 1000 },
  { k: 'clock_gap_minutes', l: 'Phone clock', s: 'Allowed gap from server time', u: 'min', type: 'number', min: 1, max: 60 },
  { k: 'offline_flag_minutes', l: 'Synced late', s: 'Offline check-in older than this', u: 'min', type: 'number', min: 5, max: 720 }
];
const t12 = (hm: string | number | undefined) => { if (typeof hm !== 'string') return '—'; const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const ERR: Record<string, string> = {
  not_yourself: 'You can’t remove your own login.', last_tech: 'Keep at least one Tech login.', is_staff: 'That email belongs to a staff member.',
  bad_email: 'Enter a valid email.', out_of_range: 'Value is outside the allowed range.', bad_time: 'Enter a time like 10:00.',
  late_before_start: '“Late until” must be after “On time until”.', not_pending: 'Already decided.'
};
const errMsg = (e: unknown) => (e instanceof ApiError && ERR[e.code]) || 'Could not save. Try again.';

// what an audit row means, in plain words
function describe(e: AuditRow): { act: string; tg: string; c: string } {
  const d = describeRaw(e); return { ...d, tg: d.tg.replace(/\s*·\s*$/, '').replace(/^\s*·\s*/, '') };
}
function describeRaw(e: AuditRow): { act: string; tg: string; c: string } {
  const a = e.after ?? {}, b = e.before ?? {}, who = e.who ? `${e.who} · ` : '';
  const st = (x: Record<string, unknown>) => x.status as string | undefined;
  switch (e.entity) {
    case 'od_requests':
      if (e.action === 'insert') return { act: 'Raised OD', tg: `${who}${a.subject ?? ''}`, c: 'c-od' };
      if (st(b) !== st(a)) return { act: `${st(a) === 'approved' ? 'Approved' : st(a) === 'returned' ? 'Returned' : cap(st(a) ?? 'Updated')} OD`, tg: `${who}${a.subject ?? ''}`, c: st(a) === 'approved' ? 'c-ok' : 'c-bad' };
      return { act: 'Edited OD', tg: `${who}${a.subject ?? ''}`, c: 'c-pend' };
    case 'leave_requests':
      if (e.action === 'insert') return { act: a.assigned_by_hr ? 'Assigned long leave' : 'Applied for leave', tg: `${who}${cap(String(a.leave_type ?? ''))}`, c: 'c-lv' };
      return { act: `${st(a) === 'approved' ? 'Approved' : st(a) === 'returned' ? 'Returned' : cap(st(a) ?? 'Updated')} leave`, tg: `${who}${cap(String(a.leave_type ?? ''))}`, c: st(a) === 'approved' ? 'c-ok' : 'c-bad' };
    case 'flags': {
      const k = flagName(String(a.kind ?? b.kind ?? ''));
      if (e.action === 'insert') return { act: `Flagged ${k.toLowerCase()}`, tg: `${who}${String(a.rule ?? '').split(' ')[0]}`, c: 'c-bad' };
      if ((a.details as Record<string, unknown>)?.false_flag_at && !(b.details as Record<string, unknown>)?.false_flag_at) return { act: 'Marked false flag', tg: `${who}${k}`, c: 'c-warn' };
      if (a.staff_reason && !b.staff_reason) return { act: 'Gave a reason', tg: `${who}${k}`, c: 'c-pend' };
      return { act: st(a) === 'reason_asked' ? 'Asked for a reason' : st(a) === 'valid' ? 'Cleared dispute' : st(a) === 'violation' ? 'Marked violation' : 'Updated flag', tg: `${who}${k}`, c: st(a) === 'valid' ? 'c-ok' : st(a) === 'violation' ? 'c-bad' : 'c-warn' };
    }
    case 'punches': return { act: a.kind === 'out' ? 'Checked out' : 'Checked in', tg: `${who}${a.place_name ?? ''}`, c: a.band === 'ok' || a.kind === 'out' ? 'c-ok' : 'c-warn' };
    case 'settings':
      if (e.entityId === 'chairman_away') return { act: a.value === true ? 'Chairman set Away' : 'Chairman set In', tg: a.value === true ? 'New OD goes to HR' : 'OD comes to Chairman', c: 'c-pend' };
      return { act: 'Changed rule', tg: `${RULES.find((r) => r.k === e.entityId)?.l ?? e.entityId} · ${JSON.stringify(b.value)} → ${JSON.stringify(a.value)}`, c: 'c-warn' };
    case 'profiles':
      if (e.action === 'insert') return { act: 'First sign-in', tg: `${a.full_name ?? ''} · ${ROLE_NAME[String(a.role)] ?? ''}`, c: 'c-ok' };
      if (e.action === 'delete') return { act: 'Removed account', tg: String(b.full_name ?? ''), c: 'c-bad' };
      if (a.role !== b.role) return { act: 'Changed role', tg: `${a.full_name} · ${ROLE_NAME[String(b.role)]} → ${ROLE_NAME[String(a.role)]}`, c: 'c-warn' };
      if (a.active !== b.active) return { act: a.active ? 'Activated' : 'Deactivated', tg: String(a.full_name ?? ''), c: a.active ? 'c-ok' : 'c-bad' };
      if (a.consent_at && !b.consent_at) return { act: 'Gave consent', tg: String(a.full_name ?? ''), c: 'c-ok' };
      return { act: 'Updated profile', tg: String(a.full_name ?? ''), c: 'c-pend' };
    case 'staff_roster': {
      const role = String(a.role ?? b.role ?? ''), isRole = ['hr', 'chairman', 'tech'].includes(role);
      if (e.action === 'insert') return { act: isRole ? 'Added role login' : 'Added staff', tg: `${a.full_name ?? ''} · ${a.email ?? ''}`, c: isRole ? 'c-warn' : 'c-ok' };
      if (e.action === 'delete') return { act: isRole ? 'Removed role login' : 'Deleted staff', tg: `${b.full_name ?? ''} · ${b.email ?? ''}`, c: 'c-bad' };
      return { act: 'Edited staff', tg: `${a.full_name ?? ''}`, c: 'c-pend' };
    }
    case 'devices':
      if (e.action === 'insert') return { act: a.status === 'pending' ? 'New phone request' : 'Phone linked', tg: `${who}${phoneName(a.user_agent as string | null)}`, c: a.status === 'pending' ? 'c-od' : 'c-ok' };
      return { act: a.status === 'active' ? 'Allowed phone' : a.status === 'revoked' ? 'Phone removed' : 'Updated phone', tg: `${who}${phoneName(a.user_agent as string | null)}`, c: a.status === 'active' ? 'c-ok' : 'c-bad' };
    case 'hubs': return { act: e.action === 'insert' ? 'Added hub' : 'Edited hub', tg: String(a.name ?? b.name ?? ''), c: 'c-pend' };
    case 'custom_roles': return { act: 'Changed custom role', tg: String(a.name ?? b.name ?? ''), c: 'c-warn' };
    default:
      if (e.action === 'export') return { act: `Exported ${e.entity}`, tg: e.entityId ?? '', c: 'c-pend' };
      return { act: `${cap(e.action)} ${e.entity}`, tg: e.entityId ?? '', c: 'c-pend' };
  }
}
const dayLabel = (iso: string) => { const d = new Date(iso + ''), t = new Date(); const k = (x: Date) => new Date(x.getTime() + 330 * 60000).toISOString().slice(0, 10);
  return k(d) === k(t) ? 'Today' : k(d) === k(new Date(t.getTime() - 864e5)) ? 'Yesterday' : fmtShortDay(d); };

function Top({ small, big, onBack, right }: { small: string; big: string; onBack: () => void; right?: React.ReactNode }) {
  return <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>{small}</small><b>{big}</b></div>{right ?? <span className="sp" />}</div>;
}
function Head({ small, big, right }: { small: string; big: string; right?: React.ReactNode }) {
  return <div style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-end', gap: 12 }}><div style={{ flex: 1 }}><small style={{ fontSize: 13, color: 'var(--ph-ink3)' }}>{small}</small><b style={{ display: 'block', fontSize: 26, fontWeight: 600, letterSpacing: '-.02em' }}>{big}</b></div>{right}</div>;
}
const VRow = ({ l, v, c }: { l: string; v: string; c: 'ok' | 'warn' | 'bad' }) => <div className="vrow"><span className={`vi ${c === 'ok' ? 'c-ok' : c === 'warn' ? 'c-warn' : 'c-bad'}`}><Icon n={c === 'ok' ? 'check' : c === 'warn' ? 'clock' : 'x'} /></span><span>{l}</span><span className="vv">{v}</span></div>;
const VBar = ({ l, p, v, col }: { l: string; p: number; v: string; col?: string }) => <div className="vbar"><span>{l}</span><span className="bar" style={{ display: 'block' }}><i style={{ width: `${Math.max(0, Math.min(100, p))}%`, background: col ?? 'var(--ph-navy)' }} /></span><b>{v}</b></div>;

function services(h: Health | null, chain: { ok: boolean; rows: number } | null) {
  if (!h) return [];
  return [
    { n: 'Database', s: `Supabase · Mumbai`, v: h.db_ok ? `${h.db_ms} ms` : 'Down', c: h.db_ok ? '' : 'bad' },
    { n: 'Selfie storage', s: h.storage === 's3' ? 'AWS S3 · Mumbai' : 'Supabase Storage · until AWS keys', v: 'On', c: h.storage === 's3' ? '' : 'p' },
    { n: 'Face match', s: h.face_match ? 'AWS Rekognition' : 'Off · needs AWS keys', v: h.face_match ? 'On' : 'Off', c: h.face_match ? '' : 'off' },
    { n: 'Place names', s: h.geocode === 'google' ? 'Google Maps' : 'OpenStreetMap · free', v: 'On', c: h.geocode === 'google' ? '' : 'p' },
    { n: 'Sign-in codes', s: 'Resend · hr.startuptn.in', v: 'On', c: '' },
    { n: 'Audit chain', s: chain ? `${chain.rows.toLocaleString('en-IN')} rows` : 'Checking…', v: chain ? (chain.ok ? 'Verified' : 'Broken') : '…', c: chain && !chain.ok ? 'bad' : chain ? '' : 'off' }
  ];
}

// ---------------- app shell ----------------
export function TechApp() {
  const { toast } = useApp();
  const [tab, setTab] = useState<Tab>('home');
  const [stack, setStack] = useState<Sub[]>([]);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; rows: number } | null>(null);
  const [roles, setRoles] = useState<Roles | null>(null);
  const [intro, setIntro] = useState(() => firstViewToday('tech-intro'));
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    tech.overview().then(setOv).catch(() => toast('Could not load'));
    tech.health().then(setHealth).catch(() => setHealth({ db_ok: false, db_ms: 0, storage: 'supabase', face_match: false, geocode: 'osm', region: '' }));
    tech.verifyChain().then(setChain).catch(() => setChain(null));
    tech.roles().then(setRoles).catch(() => setRoles(null));
  }, [toast]);
  useEffect(() => { load(); const t = setInterval(load, 120000); return () => clearInterval(t); }, [load]);
  const refresh = () => { setTick((x) => x + 1); load(); };

  const open = (s: Sub) => setStack((x) => [...x, s]);
  const back = () => setStack((x) => x.slice(0, -1));
  const svc = services(health, chain);
  if (intro && ov && health) return <Intro ov={ov} up={svc.filter((s) => s.c === '' || s.c === 'p').length} total={svc.length} onDone={() => setIntro(false)} />;

  const sheets = <TechSheets sheet={sheet} setSheet={setSheet} onChanged={refresh} />;
  const sub = stack[stack.length - 1];
  if (sub) {
    let body: React.ReactNode = null;
    if (sub.name === 'roles') body = <RolesView key={tick} onBack={back} setSheet={setSheet} />;
    if (sub.name === 'devices') body = <DevicesView key={tick} onBack={back} setSheet={setSheet} onChanged={refresh} />;
    if (sub.name === 'rules') body = <RulesView key={tick} onBack={back} setSheet={setSheet} />;
    if (sub.name === 'integrations') body = <Integrations svc={svc} health={health} onBack={back} />;
    if (sub.name === 'alert') body = <AlertView f={sub.f} onBack={back} />;
    if (sub.name === 'notifs') body = <div style={{ position: 'absolute', inset: 0 }}><Notifications onBackOverride={back} /></div>;
    return <>{body}{sheets}</>;
  }
  const t = (k: Tab, icn: string, l: string, dot = false) => (
    <button className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-label={l} aria-current={tab === k ? 'page' : undefined}><Icon n={icn} /><span>{l}</span>{dot && <i className="dotb" />}</button>
  );
  const temps = roles?.logins.filter((l) => l.temp).length ?? 0;
  return (
    <>
      {tab === 'home' && <Home ov={ov} svc={svc} temps={temps} open={open} setSheet={setSheet} goTab={setTab} />}
      {tab === 'audit' && <AuditView key={tick} setSheet={setSheet} chain={chain} recheck={() => { setChain(null); tech.verifyChain().then(setChain).catch(() => toast('Could not check')); }} />}
      {tab === 'alerts' && <AlertsView key={tick} onOpen={(f) => open({ name: 'alert', f })} />}
      {tab === 'accuracy' && <AccuracyView key={tick} />}
      {tab === 'setup' && <Setup roles={roles} ov={ov} health={health} open={open} setSheet={setSheet} />}
      <nav className="tabs t5" aria-label="Main">{t('home', 'chart', 'Overview')}{t('audit', 'list', 'Audit')}{t('alerts', 'flag', 'Alerts', (ov?.openAlerts ?? 0) > 0)}{t('accuracy', 'target', 'Accuracy')}{t('setup', 'gear', 'Setup', (ov?.newPhones ?? 0) > 0)}</nav>
      {sheets}
    </>
  );
}

function Intro({ ov, up, total, onDone }: { ov: Overview; up: number; total: number; onDone: () => void }) {
  const [k, setK] = useState(0);
  useEffect(() => {
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => { const p = Math.min(1, (t - t0) / 1100); setK(1 - Math.pow(1 - p, 3)); if (p < 1) raf = requestAnimationFrame(step); };
    const s = setTimeout(() => { raf = requestAnimationFrame(step); }, 500); const d = setTimeout(onDone, 3800);
    return () => { clearTimeout(s); clearTimeout(d); cancelAnimationFrame(raf); };
  }, [onDone]);
  return (
    <div className="welcome" role="button" tabIndex={0} onClick={onDone} aria-label="Continue">
      <div className="glow" /><div className="w1">{fmtDay()}</div>
      <div className="w2">{greeting()},<br />Tech team.</div>
      <div className="w3">{up === total ? 'All systems normal.' : total - up === 1 ? '1 service needs setup.' : `${total - up} services need setup.`}</div>
      <div className="cnt"><div><b>{Math.round(ov.checkins * k)}</b><span>Check-ins</span></div><div><b>{Math.round(ov.openAlerts * k)}</b><span>Open alerts</span></div><div><b>{Math.round(up * k)}/{total}</b><span>Services up</span></div></div>
      <div className="skip">Tap to continue</div>
    </div>
  );
}

// ---------------- overview ----------------
function Home({ ov, svc, temps, open, setSheet, goTab }: { ov: Overview | null; svc: ReturnType<typeof services>; temps: number; open: (s: Sub) => void; setSheet: (s: Sheet) => void; goTab: (t: Tab) => void }) {
  if (!ov) return <div className="scr"><Spin /></div>;
  const up = svc.filter((s) => s.c === '' || s.c === 'p').length;
  return (
    <div className="scr fade">
      <div className="hdr"><button className="av me" onClick={() => setSheet({ t: 'account' })} aria-label="Tech admin account and log out">AI</button>
        <div className="r"><button className="rbtn" onClick={() => open({ name: 'notifs' })} aria-label="Notifications"><Icon n="bell" /></button></div></div>
      <div className="dark">
        <div className="top"><div><div className="hi">{greeting()}, Tech team</div><div className="day">System health</div></div><span className="live"><i />Live</span></div>
        <div className="gcard gc4">
          <button onClick={() => open({ name: 'integrations' })}><small>Services</small><b>{svc.length ? `${up}/${svc.length}` : '…'}</b><em>up</em></button>
          <button onClick={() => goTab('audit')}><small>Check-ins</small><b>{ov.checkins}</b><em>of {ov.staff}</em></button>
          <button onClick={() => goTab('alerts')}><small>Open alerts</small><b>{ov.openAlerts}</b><em>with HR</em></button>
          <button onClick={() => goTab('accuracy')}><small>Data quality</small><b>{ov.quality ?? '—'}</b><em>avg · 7 days</em></button>
        </div>
      </div>
      <div className="sec">Needs you</div>
      <div className="needs">
        <button className="need" onClick={() => open({ name: 'devices' })}><span className="ri c-od"><Icon n="phone" /></span><span><b>{ov.newPhones}</b><span>New phone</span></span></button>
        <button className="need" onClick={() => open({ name: 'devices' })}><span className="ri c-bad"><Icon n="shield" /></span><span><b>{ov.flaggedPhones}</b><span>Flagged phones</span></span></button>
        <button className="need" onClick={() => goTab('accuracy')}><span className="ri c-warn"><Icon n="target" /></span><span><b>{ov.falseFlags}</b><span>False flags</span></span></button>
        <button className="need" onClick={() => open({ name: 'roles' })}><span className={`ri ${temps ? 'c-warn' : 'c-ok'}`}><Icon n="key" /></span><span><b>{temps}</b><span>Test logins</span></span></button>
      </div>
      <div className="sec">Services <button onClick={() => open({ name: 'integrations' })}>Details</button></div>
      <div className="card" style={{ padding: '6px 16px' }}>{svc.length ? svc.map((s) => <div className="svc" key={s.n}><span className={`dot ${s.c}`} /><span className="t">{s.n}<span>{s.s}</span></span><span className="ms">{s.v}</span></div>) : <Spin />}</div>
      <div className="sec">Last 24 hours</div>
      <div className="tiles"><div className="tile"><b>{ov.selfies24}</b><span>Selfies</span></div><div className="tile"><b>{ov.facePass != null ? `${ov.facePass}%` : 'Off'}</b><span>Face pass</span></div><div className="tile"><b>{ov.gpsMedian != null ? `${Math.round(ov.gpsMedian)} m` : '—'}</b><span>GPS median</span></div></div>
      <div className="sec">Quick</div>
      <div className="qa">
        <button onClick={() => open({ name: 'roles' })}><span className="sq"><Icon n="key" /></span>Roles</button>
        <button onClick={() => open({ name: 'devices' })}><span className="sq"><Icon n="phone" /></span>Devices</button>
        <button onClick={() => open({ name: 'rules' })}><span className="sq"><Icon n="sliders" /></span>Rules</button>
        <button onClick={() => setSheet({ t: 'exports' })}><span className="sq"><Icon n="down" /></span>Export</button>
      </div>
    </div>
  );
}

// ---------------- audit ----------------
function AuditView({ setSheet, chain, recheck }: { setSheet: (s: Sheet) => void; chain: { ok: boolean; rows: number } | null; recheck: () => void }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [q, setQ] = useState(''); const [f, setF] = useState('All');
  useEffect(() => { tech.audit().then(setRows).catch(() => setRows([])); }, []);
  const roleOf = (r: AuditRow) => (['chairman', 'hr', 'tech', 'system'].includes(r.actorRole) ? r.actorRole : 'staff');
  const list = useMemo(() => (rows ?? []).map((r) => ({ r, d: describe(r) })).filter(({ r, d }) =>
    (f === 'All' || roleOf(r) === f.toLowerCase()) && (!q || `${d.act} ${d.tg} ${r.actor}`.toLowerCase().includes(q.toLowerCase()))), [rows, q, f]);
  let day = '';
  return (
    <div className="scr fade">
      <Head small="Every action" big="Audit" right={<button className="rbtn" onClick={() => setSheet({ t: 'exports' })} aria-label="Export"><Icon n="down" /></button>} />
      <button className={`card row ${chain && !chain.ok ? 'redrow' : ''}`} style={{ width: '100%', marginBottom: 12 }} onClick={recheck}>
        <span className={`ri ${chain ? (chain.ok ? 'c-ok' : '') : 'c-pend'}`}><Icon n={chain?.ok === false ? 'alert' : 'shield'} /></span>
        <span className="t"><b>{chain ? (chain.ok ? 'Chain verified' : 'Chain broken') : 'Checking chain…'}</b><span>{chain ? `${chain.rows.toLocaleString('en-IN')} rows · append only` : 'Append only · hash chained'}</span></span><Icon n="refresh" style={{ color: 'var(--ph-ink3)' }} /></button>
      <label className="search" htmlFor="aq"><Icon n="search" /><input id="aq" placeholder="Search action or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audit" /></label>
      <div className="pillrow" role="group" aria-label="Who">{['All', 'Chairman', 'HR', 'Staff', 'System', 'Tech'].map((k) => <button key={k} className={`pill ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{k}</button>)}</div>
      {!rows ? <Spin /> : list.length === 0 ? <div className="empty"><b>No match</b>Try another filter.</div> : list.map(({ r, d }) => {
        const dl = dayLabel(r.at), h = dl !== day ? <div className="daylbl">{dl}</div> : null; day = dl;
        return <div key={r.id}>{h}<button className="lrow" onClick={() => setSheet({ t: 'entry', e: r })}><RoleAb role={roleOf(r)} name={r.actor} /><span className="t"><b>{d.act}</b><span>{d.tg || r.actor}</span></span><span className="v"><span className="tm">{fmtTime(r.at)}</span></span></button></div>;
      })}
      <p className="more">Latest 300 · export for the full log</p>
    </div>
  );
}

// ---------------- alerts ----------------
const ATYPES: [string, string | null][] = [['All', null], ['Outside radius', 'radius'], ['Location changer', 'location_changer'], ['Mock location', 'mock_location'], ['Face', 'face'], ['Late', 'late'], ['Other', '*']];
function AlertsView({ onOpen }: { onOpen: (f: Flag) => void }) {
  const [all, setAll] = useState<Flag[] | null>(null); const [ty, setTy] = useState('All');
  useEffect(() => { tech.alerts().then(setAll).catch(() => setAll([])); }, []);
  const known = ATYPES.map(([, k]) => k).filter((k): k is string => !!k && k !== '*');
  const sel = ATYPES.find(([l]) => l === ty)?.[1];
  const list = (all ?? []).filter((f) => !sel || (sel === '*' ? !known.includes(f.kind) : f.kind === sel));
  const st = (f: Flag): [string, string] => f.details?.false_flag_at ? ['False flag', 'c-pend'] : f.status === 'violation' ? ['Violation', 'c-bad'] : f.status === 'valid' ? ['Cleared', 'c-ok'] : f.status === 'reason_asked' ? ['Reason asked', 'c-warn'] : ['Open', 'c-warn'];
  return (
    <div className="scr fade">
      <Head small="Last 30 days" big="Dispute alerts" />
      {all && <div className="card"><div className="ft">
        <div><b>{all.length}</b><span>Raised</span></div><div><b>{all.filter((f) => f.status === 'valid').length}</b><span>Cleared</span></div>
        <div><b>{all.filter((f) => f.status === 'violation').length}</b><span>Violations</span></div><div><b>{all.filter((f) => f.status === 'open' || f.status === 'reason_asked').length}</b><span>Open</span></div></div></div>}
      <div className="pillrow" role="group" aria-label="Type">{ATYPES.map(([l]) => <button key={l} className={`pill ${ty === l ? 'on' : ''}`} onClick={() => setTy(l)}>{l}</button>)}</div>
      {!all ? <Spin /> : list.length === 0 ? <div className="empty"><b>No alerts</b>Nothing of this type.</div> : list.map((f) => {
        const [lab, cls] = FLAG_LABEL[f.kind] ?? [flagName(f.kind), 'c-pend'], [sl, sc] = st(f);
        return (
          <button key={f.id} className="req" style={{ width: '100%', textAlign: 'left', display: 'block', marginBottom: 10 }} onClick={() => onOpen(f)}>
            <span className="hd"><Av n={f.who} /><span className="t"><b>{f.who}</b><span>{f.hub ?? 'No hub'} · {fmtShortDay(new Date(f.created_at))} · {fmtTime(f.created_at)}</span></span><span className={`chip ${cls}`}>{lab}</span></span>
            <span className="meta" style={{ display: 'flex' }}><span className={`chip ${sc}`}>{sl}</span>{f.kind === 'radius' && f.punch?.distance_m != null && <span className="chip c-bad">{fmtDistance(f.punch.distance_m)} away</span>}{f.punch?.quality_score != null && <span className="chip c-pend">Quality {f.punch.quality_score}</span>}</span>
          </button>);
      })}
    </div>
  );
}

function AlertView({ f, onBack }: { f: Flag; onBack: () => void }) {
  const { toast } = useApp();
  const [photo, setPhoto] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(f.punch?.place_name ?? null);
  const [isFalse, setFalse] = useState(!!f.details?.false_flag_at);
  const [busy, setBusy] = useState(false);
  useEffect(() => { hr.selfieUrl(f.punch?.selfie_key ?? null).then(setPhoto); if (f.punch && !f.punch.place_name) placeLabel(f.punch.lat, f.punch.lng).then(setPlace); }, [f]);
  const pu = f.punch, q = pu?.quality_score ?? null;
  const decision = f.status === 'violation' ? ['Violation', 'c-bad'] : f.status === 'valid' ? ['Cleared', 'c-ok'] : f.status === 'reason_asked' ? ['Reason asked', 'c-warn'] : ['Open', 'c-warn'];
  const Sig = ({ l, v, c }: { l: string; v: string; c: string }) => <div className="sig"><span>{l}</span><span className={`chip ${c}`}>{v}</span></div>;
  const mark = async () => { setBusy(true); try { await tech.markFalse(f.id); setFalse(true); toast('Marked false flag'); } catch { toast('Could not save. Try again.'); } setBusy(false); };
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small={`${f.who} · ${f.hub ?? ''}`} big={flagName(f.kind)} onBack={onBack} />
      <div className="shot">{photo ? <img src={photo} alt={`${f.who} selfie`} /> : <div className="center" style={{ background: '#D9DCE3', color: 'var(--ph-ink3)', fontSize: 14 }}>No photo</div>}
        <div className="stamp">{f.who}<br />{pu ? `${fmtShortDay(new Date(pu.server_time))} · ${fmtTime(pu.server_time)} IST` : ''}<br />{place ?? ''}</div></div>
      {pu && <div className="card" style={{ marginTop: 12 }}>
        <div className="row"><span className="ri c-bad"><Icon n="pin" /></span><span className="t"><b>Probable location</b><span style={{ whiteSpace: 'normal' }}>{place ?? 'Finding place name…'}</span></span></div>
        <dl className="kv" style={{ marginTop: 12 }}>{pu.distance_m != null && <><dt>From target</dt><dd>{fmtDistance(pu.distance_m)}</dd></>}<dt>Coordinates</dt><dd>{pu.lat.toFixed(6)}, {pu.lng.toFixed(6)}</dd>{pu.accuracy_m != null && <><dt>Accuracy</dt><dd>{Math.round(pu.accuracy_m)} m</dd></>}</dl>
        <div className="two" style={{ marginTop: 12 }}>
          <a className="btn light" style={{ height: 44, fontSize: 14, textDecoration: 'none' }} href={googleMapsUrl(pu.lat, pu.lng)} target="_blank" rel="noreferrer">Google Maps</a>
          <a className="btn light" style={{ height: 44, fontSize: 14, textDecoration: 'none' }} href={appleMapsUrl(pu.lat, pu.lng)} target="_blank" rel="noreferrer">Apple Maps</a></div></div>}
      {f.staff_reason && <div className="quote" style={{ marginTop: 12 }}><small>{f.who.split(' ')[0]} says</small>“{f.staff_reason}”</div>}
      {q !== null && <div className="card" style={{ marginTop: 12 }}><div className="qhd"><span>Live data quality</span><b>{q}<small>/100</small></b></div><div className="bar"><i style={{ width: `${q}%`, background: q >= 70 ? 'var(--ok)' : 'var(--bad)' }} /></div></div>}
      <div className="sec">Validation report</div>
      <div className="card"><Sig l="Rule" v={f.rule} c="c-pend" />
        {pu?.accuracy_m != null && <Sig l="GPS accuracy" v={`${Math.round(pu.accuracy_m)} m`} c={pu.accuracy_m <= 50 ? 'c-ok' : 'c-warn'} />}
        {pu?.mocked != null && <Sig l="Mock location" v={pu.mocked ? 'Detected' : 'No'} c={pu.mocked ? 'c-bad' : 'c-ok'} />}
        {pu?.face_similarity != null && <Sig l="Face match" v={`${Math.round(pu.face_similarity)}%`} c={pu.face_similarity >= 80 ? 'c-ok' : 'c-bad'} />}</div>
      <div className="card row" style={{ marginTop: 16 }}><span className={`ri ${decision[1]}`}><Icon n="flag" /></span><span className="t"><b>HR decision</b><span>{decision[0]}</span></span></div>
      <p className="to">HR decides. Tech tunes the rules.</p>
      {isFalse ? <div className="note-hr" style={{ marginTop: 8 }}><Icon n="check" size={16} />Marked as a false flag. Counts against this rule’s precision.</div>
        : <button className="btn light" disabled={busy} onClick={mark}><Icon n="target" />Mark false flag</button>}
    </div>
  );
}

// ---------------- accuracy ----------------
function AccuracyView() {
  const [a, setA] = useState<Accuracy | null>(null); const [seg, setSeg] = useState<'gps' | 'face' | 'rules'>('gps');
  useEffect(() => { tech.accuracy().then(setA).catch(() => setA(null)); }, []);
  const mx = (xs: { n: number }[]) => Math.max(1, ...xs.map((x) => x.n));
  return (
    <div className="scr fade">
      <Head small="Last 7 days" big="Accuracy" />
      <div className="seg" role="group" aria-label="View" style={{ marginBottom: 16 }}>
        <button className={seg === 'gps' ? 'on' : ''} onClick={() => setSeg('gps')}>GPS</button><button className={seg === 'face' ? 'on' : ''} onClick={() => setSeg('face')}>Face</button><button className={seg === 'rules' ? 'on' : ''} onClick={() => setSeg('rules')}>Rules</button></div>
      {!a ? <Spin /> : seg === 'gps' ? (a.n === 0 ? <div className="empty"><b>No check-ins yet</b>Numbers appear after the first check-ins.</div> : <>
        <div className="tiles"><div className="tile"><b>{a.gpsMedian != null ? `${Math.round(a.gpsMedian)} m` : '—'}</b><span>Median</span></div><div className="tile"><b>{a.gpsP95 != null ? `${Math.round(a.gpsP95)} m` : '—'}</b><span>95th pct</span></div><div className="tile"><b>{a.within50 != null ? `${a.within50}%` : '—'}</b><span>Within 50 m</span></div></div>
        <div className="sec">Accuracy spread · {a.n} check-ins</div>
        <div className="card">{a.spread.map((s, i) => <VBar key={s.l} l={s.l} p={(s.n / mx(a.spread)) * 100} v={String(s.n)} col={i < 2 ? 'var(--ok)' : i < 3 ? 'var(--warn)' : 'var(--bad)'} />)}</div>
        <p className="to">Readings worse than 100 m are capped when checking the radius.</p></>)
      : seg === 'face' ? (a.faceN === 0 ? <div className="card row"><span className="ri c-pend"><Icon n="scan" /></span><span className="t"><b>Face match is off</b><span style={{ whiteSpace: 'normal' }}>Turns on when StartupTN’s AWS keys are added.</span></span></div> : <>
        <div className="tiles"><div className="tile"><b>{a.facePass}%</b><span>Pass</span></div><div className="tile"><b>{a.faceAvg}%</b><span>Avg score</span></div><div className="tile"><b>{a.faceN}</b><span>Checked</span></div></div>
        <div className="sec">Score spread</div>
        <div className="card">{a.faceSpread.map((s, i) => <VBar key={s.l} l={s.l} p={(s.n / mx(a.faceSpread)) * 100} v={String(s.n)} col={i < 2 ? 'var(--ok)' : i < 3 ? 'var(--warn)' : 'var(--bad)'} />)}</div></>)
      : <>
        <div className="sec" style={{ marginTop: 0 }}>Per rule · 30 days</div>
        {a.rules.length === 0 ? <div className="empty"><b>No flags yet</b>Rules report here once they fire.</div> : <div className="card">{a.rules.map((r) => {
          const decided = r.valid + r.violation, prec = decided ? Math.round((r.violation / decided) * 100) : null;
          return <VBar key={r.kind} l={flagName(r.kind)} p={prec ?? 0} v={prec != null ? `${prec}%` : `${r.raised}`} col={prec == null ? '#C6C8CF' : prec >= 60 ? 'var(--ok)' : prec >= 30 ? 'var(--warn)' : 'var(--bad)'} />;
        })}</div>}
        <p className="to">Precision = violations out of decided alerts. Low precision means the rule needs tuning.</p>
        <div className="sec">False flags</div>
        {a.falseList.length === 0 ? <div className="empty"><b>None</b>Mark one from an alert.</div> : a.falseList.map((x) => <div className="lrow" key={x.id}><Av n={x.who} /><span className="t"><b>{x.who}</b><span>{flagName(x.kind)} · {fmtShortDay(new Date(x.at))}</span></span></div>)}
      </>}
    </div>
  );
}

// ---------------- setup ----------------
function Setup({ roles, ov, health, open, setSheet }: { roles: Roles | null; ov: Overview | null; health: Health | null; open: (s: Sub) => void; setSheet: (s: Sheet) => void }) {
  const row = (onClick: () => void, icn: string, c: string, l: string, s: string, v = '') => <button className="setrow" onClick={onClick}><span className={`ri ${c}`}><Icon n={icn} /></span><span className="t"><b>{l}</b><span>{s}</span></span>{v && <span className="v">{v}</span>}<Icon n="chevR" /></button>;
  const off = health ? [!health.face_match, !health.db_ok].filter(Boolean).length : 0;
  return (
    <div className="scr fade">
      <Head small="ai@startuptn.in" big="Setup" />
      <div className="card" style={{ padding: '4px 16px' }}>
        {row(() => open({ name: 'roles' }), 'key', 'c-od', 'Roles', 'Who signs in as HR, Chairman, Tech', roles ? String(roles.logins.length) : '')}
        {row(() => open({ name: 'devices' }), 'phone', 'c-pend', 'Devices', 'Phones, new requests, flags', ov?.newPhones ? `${ov.newPhones} new` : '')}
        {row(() => open({ name: 'rules' }), 'sliders', 'c-warn', 'Rules', 'Office hours, face, location')}
      </div>
      <div className="card" style={{ padding: '4px 16px', marginTop: 12 }}>
        {row(() => open({ name: 'integrations' }), 'plug', off ? 'c-warn' : 'c-ok', 'Integrations', 'Database, storage, face, maps', off ? `${off} to set up` : 'All on')}
        {row(() => setSheet({ t: 'exports' }), 'down', 'c-pend', 'Exports', 'Attendance and audit CSV')}
        {row(() => setSheet({ t: 'privacy' }), 'lock', 'c-pend', 'Data and privacy', 'Where data lives, who sees what')}
      </div>
      <p className="more">StartupTN HR · v1 web app · updates itself</p>
    </div>
  );
}

function RolesView({ onBack, setSheet }: { onBack: () => void; setSheet: (s: Sheet) => void }) {
  const [r, setR] = useState<Roles | null>(null);
  useEffect(() => { tech.roles().then(setR).catch(() => setR({ logins: [], staff: 0, interns: 0 })); }, []);
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Setup" big="Roles" onBack={onBack} right={<button className="rbtn" onClick={() => setSheet({ t: 'addlogin' })} aria-label="Add login"><Icon n="plus" /></button>} />
      {!r ? <Spin /> : (['chairman', 'hr', 'tech'] as const).map((role) => (
        <div key={role}><div className="sec" style={{ marginTop: role === 'chairman' ? 0 : undefined }}>{ROLE_NAME[role]}</div>
          <div className="card" style={{ padding: '4px 16px' }}>{r.logins.filter((l) => l.role === role).map((l) => (
            <button key={l.email} className="setrow" onClick={() => setSheet({ t: 'login', l })}><RoleAb role={role} /><span className="t"><b>{l.name}</b><span>{l.email}</span></span>
              <span className="v">{l.temp ? <span className="chip c-warn">Test</span> : !l.signedIn ? <span className="chip c-pend">Not yet in</span> : !l.active ? <span className="chip c-bad">Off</span> : null}</span><Icon n="chevR" /></button>))}
            {r.logins.filter((l) => l.role === role).length === 0 && <p className="more" style={{ textAlign: 'left' }}>No login.</p>}</div></div>))}
      {r && r.logins.some((l) => l.temp) && <div className="note-hr" style={{ marginTop: 12 }}><Icon n="alert" size={16} />Remove test logins before the pilot.</div>}
      <div className="sec">Everyone else</div>
      <div className="card" style={{ padding: '4px 16px' }}>
        <div className="setrow"><span className="ri c-ok"><Icon n="users" /></span><span className="t"><b>Staff</b><span>Added by HR · official email</span></span><span className="v">{r?.staff ?? '—'}</span></div>
        <div className="setrow"><span className="ri c-lv"><Icon n="users" /></span><span className="t"><b>Interns</b><span>Added by HR · personal email</span></span><span className="v">{r?.interns ?? '—'}</span></div></div>
      <div className="sec">Approvals</div>
      <div className="card" style={{ padding: '6px 16px' }}><VRow l="OD · first approver" v="Chairman" c="ok" /><VRow l="OD · backup" v="HR when Away" c="ok" /><VRow l="Leave" v="HR" c="ok" /><VRow l="Disputes" v="HR" c="ok" /></div>
      <p className="to">Only the Tech admin changes role logins. Every change is in the audit log.</p>
    </div>
  );
}

function DevicesView({ onBack, setSheet, onChanged }: { onBack: () => void; setSheet: (s: Sheet) => void; onChanged: () => void }) {
  const { toast } = useApp();
  const [d, setD] = useState<Devices | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => tech.devices().then(setD).catch(() => setD({ pending: [], active: [], flagged: [] }));
  useEffect(() => { load(); }, []);
  const decide = async (x: Device, allow: boolean) => { setBusy(x.id); try { await tech.decideDevice(x.id, allow); toast(allow ? `Allowed · ${x.who.split(' ')[0]} notified` : `Denied · ${x.who.split(' ')[0]} notified`); load(); onChanged(); } catch (e) { toast(errMsg(e)); } setBusy(null); };
  const ios = d?.active.filter((x) => /iPhone|iPad/.test(x.ua ?? '')).length ?? 0, and = d?.active.filter((x) => /Android/.test(x.ua ?? '')).length ?? 0;
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Setup" big="Devices" onBack={onBack} />
      {!d ? <Spin /> : <>
        <div className="sec" style={{ marginTop: 0 }}>New phone · {d.pending.length}</div>
        {d.pending.length === 0 ? <div className="card empty" style={{ padding: 20 }}><b>No requests</b>A second phone waits here for you.</div> : d.pending.map((x) => {
          const old = d.active.find((a) => a.userId === x.userId);
          return (
            <div className="req" key={x.id} style={{ marginBottom: 10 }}>
              <div className="hd"><Av n={x.who} /><div className="t"><b>{x.who}</b><span>{x.hub ?? 'No hub'} · {fmtShortDay(new Date(x.created_at))} {fmtTime(x.created_at)}</span></div><span className="chip c-od">New phone</span></div>
              <div className="meta">{old && <span className="chip c-pend">Old · {phoneName(old.ua)}</span>}<span className="chip c-pend">New · {phoneName(x.ua)}</span></div>
              <div className="acts"><button className="btn light" disabled={busy === x.id} onClick={() => decide(x, false)}>Deny</button><button className="btn dark" disabled={busy === x.id} onClick={() => decide(x, true)}><Icon n="check" />Allow</button></div>
            </div>);
        })}
        <div className="sec">Flagged · 30 days</div>
        {d.flagged.length === 0 ? <p className="more" style={{ textAlign: 'left', marginTop: 0 }}>No mock location or device flags.</p> : d.flagged.map((x) => <div className="lrow" key={x.userId}><Av n={x.who} /><span className="t"><b>{x.who}</b><span>{x.hub ?? ''} · {fmtShortDay(new Date(x.at))}</span></span><span className="v"><span className="chip c-bad">{flagName(x.kind)}</span></span></div>)}
        <div className="sec">Platform</div>
        <div className="tiles"><div className="tile"><b>{and}</b><span>Android</span></div><div className="tile"><b>{ios}</b><span>iPhone</span></div><div className="tile"><b>{d.active.length - and - ios}</b><span>Other</span></div></div>
        <div className="sec">Linked phones · {d.active.length}</div>
        {d.active.map((x) => <button className="lrow" key={x.id} onClick={() => setSheet({ t: 'device', d: x })}><Av n={x.who} /><span className="t"><b>{x.who}</b><span>{phoneName(x.ua)}</span></span><span className="v"><span className="tm">{fmtShortDay(new Date(x.approved_at ?? x.created_at))}</span></span></button>)}
        <p className="to">One phone per person. The first phone links on its own; another phone waits for you.</p>
      </>}
    </div>
  );
}

function RulesView({ onBack, setSheet }: { onBack: () => void; setSheet: (s: Sheet) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { tech.settings().then(setS).catch(() => setS({})); }, []);
  const show = (r: (typeof RULES)[number]) => (r.type === 'time' ? t12(s?.[r.k]) : `${s?.[r.k] ?? '—'} ${r.u}`);
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Setup" big="Rules" onBack={onBack} />
      {!s ? <Spin /> : <>
        <div className="card" style={{ padding: '6px 16px' }}><VRow l="Office hours" v={`${t12(s.office_start)} – ${t12(s.office_end)}`} c="ok" /><VRow l="On time" v={`By ${t12(s.office_start)}`} c="ok" /><VRow l="Late" v={`Until ${t12(s.late_until)}`} c="warn" /><VRow l="Very late" v={`After ${t12(s.late_until)}`} c="bad" /></div>
        <div className="sec">Tunable</div>
        <div className="card" style={{ padding: '4px 16px' }}>{RULES.map((r) => <button key={r.k} className="setrow" onClick={() => setSheet({ t: 'rule', k: r.k, v: String(s[r.k] ?? '') })}><span className="t"><b>{r.l}</b><span>{r.s}</span></span><span className="v">{show(r)}</span><Icon n="chevR" /></button>)}</div>
        <div className="sec">Per hub</div>
        <div className="card row"><span className="ri c-pend"><Icon n="building" /></span><span className="t"><b>Radius and pin</b><span>HR sets each hub’s pin and radius</span></span></div>
        <p className="to">Changes apply from the next check-in and are logged.</p>
      </>}
    </div>
  );
}

function Integrations({ svc, health, onBack }: { svc: ReturnType<typeof services>; health: Health | null; onBack: () => void }) {
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Setup" big="Integrations" onBack={onBack} />
      <div className="card" style={{ padding: '6px 16px' }}>{svc.length ? svc.map((s) => <div className="svc" key={s.n}><span className={`dot ${s.c}`} /><span className="t">{s.n}<span>{s.s}</span></span><span className="ms">{s.v}</span></div>) : <Spin />}</div>
      {health && (!health.face_match || health.geocode !== 'google') && <>
        <div className="sec">To switch on</div>
        <div className="card"><ul className="tline">
          {!health.face_match && <li className="k"><b>AWS keys · S3 + Rekognition</b><span>Moves selfies to StartupTN’s AWS (Mumbai) and turns on face match. Keys go in Supabase function secrets.</span></li>}
          {health.geocode !== 'google' && <li><b>Google Maps key</b><span>Place names exactly as Google Maps shows them. Optional; OpenStreetMap works meanwhile.</span></li>}
        </ul></div></>}
      <p className="to">Keys are never shown here. Region {health?.region || 'ap-south-1'}.</p>
    </div>
  );
}

// ---------------- sheets ----------------
function TechSheets({ sheet, setSheet, onChanged }: { sheet: Sheet; setSheet: (s: Sheet) => void; onChanged: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [role, setRole] = useState<RoleLogin['role'] | null>(null);
  const [val, setVal] = useState(''); const [confirm, setConfirm] = useState(false);
  const months = useMemo(() => Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7); }), []);
  const [month, setMonth] = useState(months[0]);
  useEffect(() => {
    setBusy(false); setErr(null); setConfirm(false); setName(''); setEmail(''); setRole(null);
    if (sheet?.t === 'rule') setVal(sheet.v);
  }, [sheet]);
  if (!sheet) return null;
  const close = () => setSheet(null);
  const wrap = (label: string, inner: React.ReactNode) => <><div className="scrim" onClick={close} /><div className="sheet" role="dialog" aria-label={label}><div className="grab" />{inner}</div></>;
  const run = async (fn: () => Promise<void>, ok: string) => { setBusy(true); setErr(null); try { await fn(); toast(ok); onChanged(); close(); } catch (e) { setErr(errMsg(e)); setBusy(false); } };

  if (sheet.t === 'account') return <AccountSheet name="Tech admin" sub="Tech admin · All systems" onClose={close} />;
  if (sheet.t === 'entry') {
    const e = sheet.e, d = describe(e);
    const keys = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])].filter((k) => JSON.stringify(e.before?.[k]) !== JSON.stringify(e.after?.[k]) && !['updated_at', 'created_at'].includes(k));
    const fmt = (v: unknown) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    return wrap(d.act, <div className="scrollable">
      <div className="row"><RoleAb role={['chairman', 'hr', 'tech', 'system'].includes(e.actorRole) ? e.actorRole : 'staff'} name={e.actor} /><div className="t"><b style={{ fontSize: 18 }}>{d.act}</b><span>{d.tg}</span></div></div>
      <dl className="kv" style={{ marginTop: 14 }}><dt>Actor</dt><dd>{e.actor}</dd><dt>Role</dt><dd>{ROLE_NAME[e.actorRole] ?? e.actorRole}</dd><dt>When</dt><dd>{fmtShortDay(new Date(e.at))} · {fmtTime(e.at)} IST</dd><dt>Table</dt><dd>{e.entity}</dd><dt>Row</dt><dd style={{ wordBreak: 'break-all' }}>{e.entityId ?? '—'}</dd></dl>
      {keys.length > 0 && <><div className="sec">Change</div><div className="card" style={{ padding: '6px 16px' }}>{keys.slice(0, 12).map((k) => <div className="vrow" key={k} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span>{k}</span><span className="vv" style={{ wordBreak: 'break-all', maxWidth: 190 }}>{fmt(e.before?.[k])} → {fmt(e.after?.[k])}</span></div>)}</div></>}
      <div className="sec">Chain</div>
      <dl className="kv"><dt>Hash</dt><dd style={{ fontFamily: 'var(--mono)', fontSize: 11, wordBreak: 'break-all' }}>{e.hash.slice(0, 32)}…</dd><dt>Previous</dt><dd style={{ fontFamily: 'var(--mono)', fontSize: 11, wordBreak: 'break-all' }}>{e.prev ? `${e.prev.slice(0, 32)}…` : 'First row'}</dd></dl>
      <button className="btn ghost" style={{ marginTop: 10 }} onClick={close}>Close</button></div>);
  }
  if (sheet.t === 'addlogin') {
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && role;
    return wrap('Add login', <>
      <h3>Add login</h3><p>They sign in with an emailed code.</p>
      <div className="fld"><span>Role</span><div className="rolechips" role="group" aria-label="Role">{(['hr', 'chairman', 'tech'] as const).map((r) => <button key={r} className={role === r ? 'on' : ''} aria-pressed={role === r} onClick={() => setRole(r)}>{ROLE_NAME[r]}</button>)}</div></div>
      <label className="fld"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="HR team" /></label>
      <label className="fld"><span>Email</span><input type="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@startuptn.in" /></label>
      {err && <div className="err">{err}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 18 }}>
        <button className="btn dark" disabled={!ok || busy} onClick={() => run(() => tech.addLogin(email, name.trim() || ROLE_NAME[role!], role!), `Added · ${email.trim().toLowerCase()}`)}>{busy ? 'Saving' : 'Add'}</button>
        <button className="btn ghost" onClick={close}>Cancel</button></div></>);
  }
  if (sheet.t === 'login') {
    const l = sheet.l;
    return wrap(l.name, <>
      <div className="row"><RoleAb role={l.role} /><div className="t"><b style={{ fontSize: 18 }}>{l.name}</b><span>{ROLE_NAME[l.role]}</span></div>{l.temp && <span className="chip c-warn">Test</span>}</div>
      <dl className="kv" style={{ marginTop: 14 }}><dt>Login</dt><dd style={{ wordBreak: 'break-all' }}>{l.email}</dd><dt>Status</dt><dd>{!l.signedIn ? 'Not signed in yet' : l.active ? 'Active' : 'Off'}</dd></dl>
      {err && <div className="err">{err}</div>}
      {!confirm ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 18 }}>
        <button className="btn light" style={{ color: 'var(--bad)' }} onClick={() => setConfirm(true)}>Remove login</button><button className="btn ghost" onClick={close}>Close</button></div>
        : <><p className="to" style={{ marginTop: 14 }}>{l.email} loses {ROLE_NAME[l.role]} access at once. Their past actions stay in the audit log.</p>
          <div className="two"><button className="btn light" onClick={() => setConfirm(false)}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => run(() => tech.removeLogin(l.email), 'Login removed')}>Remove</button></div></>}
    </>);
  }
  if (sheet.t === 'rule') {
    const r = RULES.find((x) => x.k === sheet.k)!;
    const n = Number(val), valid = r.type === 'time' ? /^([01]\d|2[0-3]):[0-5]\d$/.test(val) : val !== '' && n >= (r.min ?? 0) && n <= (r.max ?? 1e9);
    return wrap(r.l, <>
      <h3>{r.l}</h3><p>{r.s}.</p>
      <label className="fld"><span>{r.type === 'time' ? 'Time' : `Value${r.u ? ` (${r.u})` : ''} · ${r.min}–${r.max}`}</span>
        <input type={r.type === 'time' ? 'time' : 'number'} inputMode={r.type === 'time' ? undefined : 'numeric'} value={val} min={r.min} max={r.max} onChange={(e) => setVal(e.target.value)} /></label>
      {err && <div className="err">{err}</div>}
      <p className="to">Applies from the next check-in. Logged.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        <button className="btn dark" disabled={!valid || busy} onClick={() => run(() => tech.setSetting(r.k, r.type === 'time' ? val : n), `${r.l} saved`)}>{busy ? 'Saving' : 'Save'}</button>
        <button className="btn ghost" onClick={close}>Cancel</button></div></>);
  }
  if (sheet.t === 'device') {
    const d = sheet.d;
    return wrap(d.who, <>
      <div className="row"><Av n={d.who} /><div className="t"><b style={{ fontSize: 18 }}>{d.who}</b><span>{d.hub ?? 'No hub'}</span></div></div>
      <dl className="kv" style={{ marginTop: 14 }}><dt>Phone</dt><dd>{phoneName(d.ua)}</dd><dt>Linked</dt><dd>{fmtShortDay(new Date(d.approved_at ?? d.created_at))}</dd></dl>
      {err && <div className="err">{err}</div>}
      {!confirm ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 18 }}>
        <button className="btn light" onClick={() => setConfirm(true)}><Icon n="refresh" />Reset phone</button><button className="btn ghost" onClick={close}>Close</button></div>
        : <><p className="to" style={{ marginTop: 14 }}>Unlinks this phone. The next phone {d.who.split(' ')[0]} checks in from links on its own.</p>
          <div className="two"><button className="btn light" onClick={() => setConfirm(false)}>Cancel</button><button className="btn dark" disabled={busy} onClick={() => run(() => tech.resetDevices(d.userId), 'Phone reset')}>Reset</button></div></>}
    </>);
  }
  if (sheet.t === 'exports') {
    const dl = async (kind: 'attendance' | 'audit') => {
      setBusy(true); setErr(null);
      try {
        const csv = await tech.exportCsv(kind, month);
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = `stn-${kind}-${month}.csv`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('Downloaded · logged');
      } catch { setErr('Could not export. Try again.'); }
      setBusy(false);
    };
    return wrap('Exports', <>
      <h3>Exports</h3><p>CSV opens in Excel. Every export is logged.</p>
      <label className="fld"><span>Month</span><select value={month} onChange={(e) => setMonth(e.target.value)}>{months.map((m) => <option key={m} value={m}>{new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</option>)}</select></label>
      {err && <div className="err">{err}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
        <button className="btn dark" disabled={busy} onClick={() => dl('attendance')}><Icon n="down" />Attendance</button>
        <button className="btn light" disabled={busy} onClick={() => dl('audit')}><Icon n="down" />Audit log</button>
        <button className="btn ghost" onClick={close}>Close</button></div></>);
  }
  return wrap('Data and privacy', <>
    <h3>Data and privacy</h3><p>DPDP-ready by design.</p>
    <div className="card" style={{ padding: '6px 16px', marginTop: 12 }}>
      <VRow l="Data stays in India" v="Mumbai" c="ok" />
      <VRow l="Consent on first sign-in" v="Recorded" c="ok" />
      <VRow l="Staff see only their own" v="Times, places" c="ok" />
      <VRow l="Radius and flags hidden from staff" v="Always" c="ok" />
      <VRow l="Audit log" v="Can’t edit" c="ok" />
      <VRow l="Selfie retention" v="Set before pilot" c="warn" />
    </div>
    <button className="btn ghost" style={{ marginTop: 10 }} onClick={close}>Close</button></>);
}
