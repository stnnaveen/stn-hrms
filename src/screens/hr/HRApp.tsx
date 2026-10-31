import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../App';
import { errorText, ApiError } from '../../lib/api';
import { hr, FLAG_LABEL, type Flag, type HrToday, type Hub, type LeaveReq, type OdReq, type Person, type PersonDetail, type Pin } from '../../lib/hr';
import { placeLabel, googleMapsUrl, appleMapsUrl, fmtDistance } from '../../lib/geo';
import { fmtShortDay, fmtTime, greeting } from '../../lib/time';
import { parseVenue } from '../Forms';
import { Icon } from '../../ui/Icon';
import { Notifications } from '../Notifications';
import { AccountSheet } from '../../ui/AccountSheet';
import { VenueLink } from '../../ui/VenueLink';

type Tab = 'home' | 'staff' | 'approvals' | 'disputes';
type Sub = { name: 'today' } | { name: 'person'; p: Person } | { name: 'dispute'; f: Flag } | { name: 'hubs' } | { name: 'hub'; h: Hub | null }
  | { name: 'add' } | { name: 'long'; p?: Person } | { name: 'notifs' };

const TINTS = ['#3B4A6B', '#5B4AA8', '#2F62D9', '#1F7A55', '#9C3F5A', '#7A5A2E', '#4E5464'];
const tint = (s: string) => TINTS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
const ini = (n: string) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const Av = ({ n }: { n: string }) => <span className="av sm" style={{ background: tint(n) }} aria-hidden="true">{ini(n)}</span>;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
// Suggestions only; HR can type any designation
const DESIGNATIONS = ['Project Associate', 'Senior Project Associate', 'Project Lead', 'Hub Lead', 'Manager', 'Senior Manager', 'AVP', 'VP', 'Consultant', 'Intern'];

function Top({ small, big, onBack, right }: { small: string; big: string; onBack: () => void; right?: React.ReactNode }) {
  return <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>{small}</small><b>{big}</b></div>{right ?? <span className="sp" />}</div>;
}
function Head({ small, big, right }: { small: string; big: string; right?: React.ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 }}><div><small style={{ fontSize: 13, color: 'var(--ph-ink3)' }}>{small}</small><b style={{ display: 'block', fontSize: 26, fontWeight: 600, letterSpacing: '-.02em' }}>{big}</b></div>{right}</div>;
}
function Spin() { return <div className="center" style={{ height: 240 }}><span className="spin dark" /></div>; }
function dayChip(p: Person) {
  if (p.invited) return <span className="chip c-warn">Invited</span>;
  const t = p.today;
  if (!t?.in_time) return <span className="chip c-pend">Not in</span>;
  if (t.status === 'od') return <span className="chip c-od">OD</span>;
  const c = t.band === 'ok' ? 'c-ok' : t.band === 'warn' ? 'c-warn' : 'c-bad';
  return <span className={`chip ${c}`}>{fmtTime(t.in_time)}</span>;
}

export function HRApp() {
  const { toast } = useApp();
  const [tab, setTab] = useState<Tab>('home');
  const [stack, setStack] = useState<Sub[]>([]);
  const [fab, setFab] = useState(false);
  const [counts, setCounts] = useState<HrToday | null>(null);
  const refresh = useCallback(() => { hr.today().then(setCounts).catch(() => toast('Could not load')); }, [toast]);
  useEffect(() => { refresh(); }, [refresh]);
  const open = (s: Sub) => { setFab(false); setStack((x) => [...x, s]); };
  const back = () => { setStack((x) => x.slice(0, -1)); refresh(); };
  const sub = stack[stack.length - 1];

  if (sub) {
    switch (sub.name) {
      case 'today': return <Today onBack={back} open={open} />;
      case 'person': return <PersonView p={sub.p} onBack={back} open={open} />;
      case 'dispute': return <DisputeView f={sub.f} onBack={back} />;
      case 'hubs': return <Hubs onBack={back} open={open} />;
      case 'hub': return <HubEdit h={sub.h} onBack={back} />;
      case 'add': return <AddStaff onBack={back} />;
      case 'long': return <LongLeave p={sub.p} onBack={back} />;
      case 'notifs': return <NotifWrap onBack={back} />;
    }
  }
  const pend = (counts?.pending_leave ?? 0) + (counts?.chairman_away ? counts?.pending_od ?? 0 : 0);
  const t = (k: Tab, icn: string, l: string, dot = false) => (
    <button className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-label={l} aria-current={tab === k ? 'page' : undefined}>
      <Icon n={icn} /><span>{l}</span>{dot && <i className="dotb" />}</button>
  );
  return (
    <>
      {tab === 'home' && <Home c={counts} open={open} setTab={setTab} />}
      {tab === 'staff' && <StaffList open={open} />}
      {tab === 'approvals' && <Approvals c={counts} onChange={refresh} />}
      {tab === 'disputes' && <Disputes open={open} />}
      {fab && (<><div className="scrim" onClick={() => setFab(false)} />
        <div className="fmenu" style={{ bottom: 'calc(env(safe-area-inset-bottom,0px) + 160px)' }}>
          <button onClick={() => open({ name: 'hubs' })}><span className="ri c-ok"><Icon n="building" /></span>Hub</button>
          <button onClick={() => open({ name: 'long' })}><span className="ri c-lv"><Icon n="leaf" /></span>Long leave</button>
          <button onClick={() => open({ name: 'add' })}><span className="ri c-od"><Icon n="userplus" /></span>Staff</button>
        </div></>)}
      <button className={`fab ${fab ? 'open' : ''}`} style={{ bottom: 'calc(env(safe-area-inset-bottom,0px) + 100px)' }} onClick={() => setFab(!fab)} aria-label={fab ? 'Close' : 'Add'} aria-expanded={fab}><Icon n="plus" /></button>
      <nav className="tabs t4" aria-label="Main">
        {t('home', 'home', 'Home')}{t('staff', 'users', 'Staff')}{t('approvals', 'inbox', 'Approvals', pend > 0)}{t('disputes', 'flag', 'Disputes', (counts?.open_flags ?? 0) > 0)}
      </nav>
    </>
  );
}

function Home({ c, open, setTab }: { c: HrToday | null; open: (s: Sub) => void; setTab: (t: Tab) => void }) {
  const [account, setAccount] = useState(false);
  if (!c) return <div className="scr"><Spin /></div>;
  const notIn = Math.max(0, c.staff - c.checked_in - c.leave);
  return (
    <><div className="scr fade">
      <div className="hdr"><button className="av me" onClick={() => setAccount(true)} aria-label="HR account and log out">HR</button><div className="r">
        <button className="rbtn" onClick={() => open({ name: 'hubs' })} aria-label="Hubs"><Icon n="building" /></button>
        <button className="rbtn" onClick={() => open({ name: 'notifs' })} aria-label="Notifications"><Icon n="bell" /></button></div></div>
      <div className="dark">
        <div className="top"><div><div className="hi">{greeting()}, HR team</div><div className="day">Today, {fmtShortDay()}</div></div><span className="chip c-mute"><i />{c.staff} staff</span></div>
        <button className="gcard" onClick={() => open({ name: 'today' })} aria-label="Open today's attendance">
          <span><small>Checked in</small><b>{c.checked_in}</b><em>{c.late} late</em></span>
          <span><small>OD · Leave</small><b>{c.od + c.leave}</b><em>{c.od} · {c.leave}</em></span>
          <span><small>Not in</small><b>{notIn}</b><em>Of {c.staff}</em></span>
        </button>
      </div>
      <div className="sec">Needs you</div>
      <div className="needs">
        <button className="need" onClick={() => setTab('approvals')}><span className="ri c-lv"><Icon n="leaf" /></span><span><b>{c.pending_leave}</b><span>Leave</span></span></button>
        <button className="need" onClick={() => setTab('approvals')}><span className="ri c-od"><Icon n="brief" /></span><span><b>{c.pending_od}</b><span>{c.chairman_away ? 'OD backup' : 'OD · Chairman'}</span></span></button>
        <button className="need" onClick={() => setTab('disputes')}><span className="ri c-bad"><Icon n="flag" /></span><span><b>{c.open_flags}</b><span>Disputes</span></span></button>
        <button className="need" onClick={() => open({ name: 'today' })}><span className="ri c-pend"><Icon n="clock" /></span><span><b>{notIn}</b><span>Not in</span></span></button>
      </div>
      <div className="sec">Quick action</div>
      <div className="qa">
        <button onClick={() => open({ name: 'add' })}><span className="sq"><Icon n="userplus" /></span>Add staff</button>
        <button onClick={() => open({ name: 'hubs' })}><span className="sq"><Icon n="building" /></span>Hubs</button>
        <button onClick={() => open({ name: 'long' })}><span className="sq"><Icon n="leaf" /></span>Long leave</button>
        <button onClick={() => setAccount(true)}><span className="sq"><Icon n="out" /></span>Log out</button>
      </div>
    </div>
    {account && <AccountSheet name="HR team" sub="HR · All hubs" onClose={() => setAccount(false)} />}
    </>
  );
}

function usePeople() {
  const [list, setList] = useState<Person[] | null>(null);
  useEffect(() => { hr.people().then(setList).catch(() => setList([])); }, []);
  return list;
}

function Today({ onBack, open }: { onBack: () => void; open: (s: Sub) => void }) {
  const people = usePeople();
  const [f, setF] = useState<'in' | 'late' | 'out' | 'od'>('in');
  const lab = { in: 'Checked in', late: 'Late', out: 'Not in', od: 'OD' };
  const list = (people ?? []).filter((p) => p.active && !p.invited && (
    f === 'in' ? !!p.today?.in_time : f === 'late' ? ['warn', 'bad'].includes(p.today?.band ?? '') : f === 'od' ? p.today?.status === 'od' : !p.today?.in_time));
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Today" big="Attendance" onBack={onBack} />
      <div className="pillrow" role="group" aria-label="Filter">{(Object.keys(lab) as (keyof typeof lab)[]).map((k) => <button key={k} className={`pill ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{lab[k]}</button>)}</div>
      {!people ? <Spin /> : <div className="list">{list.map((p) => (
        <button key={p.id} className="card row" onClick={() => open({ name: 'person', p })}><Av n={p.full_name} /><div className="t"><b>{p.full_name}</b><span>{p.hub ?? 'No hub'} hub</span></div>{dayChip(p)}</button>
      ))}{list.length === 0 && <div className="empty"><b>No one here</b>Try another filter.</div>}</div>}
    </div>
  );
}

function StaffList({ open }: { open: (s: Sub) => void }) {
  const people = usePeople();
  const [q, setQ] = useState('');
  const [f, setF] = useState('All');
  const list = (people ?? []).filter((p) => (f === 'All' ? p.active : f === 'Interns' ? p.role === 'intern' && p.active : f === 'Late' ? ['warn', 'bad'].includes(p.today?.band ?? '') : f === 'Invited' ? !!p.invited : !p.active)
    && (!q || `${p.full_name} ${p.hub}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="scr fade">
      <Head small={`${people?.filter((p) => p.active).length ?? '–'} people`} big="Staff" right={<button className="rbtn" onClick={() => open({ name: 'add' })} aria-label="Add staff"><Icon n="userplus" /></button>} />
      <label className="search" htmlFor="q"><Icon n="search" /><input id="q" placeholder="Search name or hub" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search staff" /></label>
      <div className="pillrow" role="group" aria-label="Filter">{['All', 'Late', 'Interns', 'Invited', 'Inactive'].map((k) => <button key={k} className={`pill ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{k}</button>)}</div>
      {!people ? <Spin /> : <div className="list">{list.map((p) => (
        <button key={p.id} className="card row" onClick={() => open({ name: 'person', p })}><Av n={p.full_name} /><div className="t"><b>{p.full_name}</b><span>{p.designation ?? cap(p.role)} · {p.hub ?? 'No hub'}</span></div>{p.active ? dayChip(p) : <span className="chip c-pend">Inactive</span>}</button>
      ))}{list.length === 0 && <div className="empty"><b>No match</b>Try another name or hub.</div>}</div>}
    </div>
  );
}

function pattern(pins: Pin[]): { same: boolean; drift: string } {
  if (pins.length < 3) return { same: false, drift: 'Not enough check-ins yet' };
  const cx = pins.reduce((a, p) => a + p.lat, 0) / pins.length, cy = pins.reduce((a, p) => a + p.lng, 0) / pins.length;
  const d = pins.map((p) => Math.hypot((p.lat - cx) * 111320, (p.lng - cy) * 111320 * Math.cos((cx * Math.PI) / 180)));
  const max = Math.max(...d), accs = new Set(pins.map((p) => p.accuracy_m));
  return { same: max < 1 && accs.size === 1, drift: `Drifts up to ${Math.round(max)} m` };
}

const DOT: Record<string, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', od: 'var(--od)', leave: 'var(--lv)', absent: '#C9CCD3' };
const STATUS_CHIP: Record<string, string> = { approved: 'c-ok', pending: 'c-pend', returned: 'c-bad', cancelled: 'c-pend' };

function MonthCalendar({ d }: { d: PersonDetail }) {
  const ist = new Date(Date.now() + 330 * 60000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), today = ist.getUTCDate();
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay(), len = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const key = (n: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
  const byDay = new Map(d.days.map((x) => [x.day, x]));
  const onLeave = (k: string) => d.leaves.some((l) => l.status === 'approved' && l.starts_on <= k && l.ends_on >= k);
  const state = (n: number): string | null => {
    const k = key(n), wd = new Date(Date.UTC(y, m, n)).getUTCDay(), rec = byDay.get(k);
    if (onLeave(k)) return 'leave';
    if (rec?.status === 'od') return 'od';
    if (rec?.band) return rec.band;
    if (n < today && wd !== 0 && wd !== 6) return 'absent';
    return null;
  };
  const counts = { ok: 0, warn: 0, bad: 0, od: 0, leave: 0, absent: 0 } as Record<string, number>;
  for (let n = 1; n <= len; n++) { const st = state(n); if (st) counts[st]++; }
  return (
    <div className="card">
      <div className="cal">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <span className="dw" key={i}>{w}</span>)}
        {Array.from({ length: first }, (_, i) => <button key={`b${i}`} className="blank" aria-hidden="true" />)}
        {Array.from({ length: len }, (_, i) => i + 1).map((n) => {
          const st = state(n), wd = new Date(Date.UTC(y, m, n)).getUTCDay();
          return <button key={n} className={`${n === today ? 'today' : ''} ${wd === 0 || wd === 6 ? 'off' : ''}`} aria-label={`${n}${st ? `, ${st}` : ''}`} tabIndex={-1}>
            {n}{st ? <i style={{ background: DOT[st] }} /> : <i style={{ background: 'transparent' }} />}</button>;
        })}
      </div>
      <div className="legend">
        <span><i style={{ background: DOT.ok }} />On time {counts.ok}</span><span><i style={{ background: DOT.warn }} />Slightly late {counts.warn}</span>
        <span><i style={{ background: DOT.bad }} />Late {counts.bad}</span><span><i style={{ background: DOT.od }} />OD {counts.od}</span>
        <span><i style={{ background: DOT.leave }} />Leave {counts.leave}</span><span><i style={{ background: DOT.absent }} />No check-in {counts.absent}</span>
      </div>
    </div>
  );
}

function PersonView({ p: p0, onBack, open }: { p: Person; onBack: () => void; open: (s: Sub) => void }) {
  const { toast } = useApp();
  const [p, setP] = useState<Person>(p0);
  const [d, setD] = useState<PersonDetail | null>(null);
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [photos, setPhotos] = useState<Record<string, string | null>>({});
  const [sheet, setSheet] = useState<null | 'deact' | 'delete' | 'edit'>(null);
  const [active, setActive] = useState(p.active);
  useEffect(() => {
    if (p.invited) return;
    hr.personDetail(p.id).then(async (x) => {
      setD(x);
      const urls: Record<string, string | null> = {};
      for (const pu of x.punches) urls[pu.kind] = await hr.selfieUrl(pu.selfie_key);
      setPhotos(urls);
    }).catch(() => setD({ punches: [], days: [], ods: [], leaves: [] }));
    hr.pins(p.id).then(setPins).catch(() => setPins([]));
  }, [p.id, p.invited]);
  const pat = pins ? pattern(pins) : null;
  const first = p.full_name.split(' ')[0];
  const del = async () => {
    try { await hr.deleteStaff(p.email); toast(`${first} deleted`); onBack(); }
    catch (e) { setSheet(null); toast(e instanceof ApiError && e.code === 'has_records' ? 'Has attendance records. Deactivate instead.' : e instanceof ApiError && e.code === 'role_account' ? 'Role accounts are managed by Tech admin.' : 'Could not delete. Try again.'); }
  };
  const punch = (k: 'in' | 'out') => d?.punches.find((x) => x.kind === k);
  const Tile = ({ k }: { k: 'in' | 'out' }) => {
    const pu = punch(k);
    if (!pu) return <div className="ph none">{k === 'in' ? 'No check-in' : 'Not checked out'}</div>;
    return (
      <div className="ph">{photos[k] ? <img src={photos[k]!} alt={`${p.full_name} check-${k}`} /> : <div className="center" style={{ background: '#D9DCE3', color: 'var(--ph-ink3)', fontSize: 12 }}>Photo</div>}
        <div className="stamp">{k === 'in' ? 'In' : 'Out'} · {fmtTime(pu.server_time)}<br />{pu.place_name ?? `${pu.lat.toFixed(4)}, ${pu.lng.toFixed(4)}`}</div></div>
    );
  };
  return (
    <><div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Staff" big="Profile" onBack={onBack} />
      <div className="pcard"><span className="av" style={{ background: tint(p.full_name), display: 'grid', placeItems: 'center', color: '#fff' }}>{ini(p.full_name)}</span><h2>{p.full_name}</h2><p>{p.designation ?? cap(p.role)} · {p.hub ?? 'No hub'} hub</p>
        <div className="meta">{p.invited ? <span className="chip c-warn">Invited · not signed in</span> : <>{dayChip(p)}<span className="chip c-mute">Face {p.face_status}</span></>}{!active && <span className="chip c-pend">Inactive</span>}</div></div>

      {p.invited ? (
        <div className="note-hr" style={{ marginTop: 16 }}><Icon n="mail" size={16} />Signs in with a code sent to {p.email}. Status turns active after first sign-in.</div>
      ) : (<>
        <div className="sec">Today</div>
        {!d ? <Spin /> : (<>
          <div className="dayc"><Tile k="in" /><Tile k="out" /></div>
          {punch('in') && <div className="meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {punch('in')!.band && <span className={`chip ${punch('in')!.band === 'ok' ? 'c-ok' : punch('in')!.band === 'warn' ? 'c-warn' : 'c-bad'}`}>{punch('in')!.band === 'ok' ? 'On time' : punch('in')!.band === 'warn' ? 'Slightly late' : 'Late'}</span>}
            {punch('in')!.distance_m != null && <span className="chip c-pend">{fmtDistance(punch('in')!.distance_m!)} from target</span>}
            {punch('out')?.early_out && <span className="chip c-bad">Early out</span>}
          </div>}
        </>)}

        <div className="sec">This month</div>
        {!d ? <Spin /> : <MonthCalendar d={d} />}

        <div className="sec">OD</div>
        <div className="card">
          {!d ? <Spin /> : d.ods.length === 0 ? <span style={{ color: 'var(--ph-ink3)', fontSize: 14 }}>No OD yet.</span> : d.ods.map((o) => (
            <div className="row" key={o.id}><div className="ri c-od"><Icon n="brief" /></div>
              <div className="t"><b>{o.subject}</b><span>{fmtShortDay(new Date(o.starts_at))} · {fmtTime(o.starts_at)} to {fmtTime(o.ends_at)} · {o.venue_name}</span></div>
              <span className={`chip ${STATUS_CHIP[o.status] ?? 'c-pend'}`}>{cap(o.status)}</span></div>))}
        </div>

        {d && d.leaves.length > 0 && (<>
          <div className="sec">Leave</div>
          <div className="card">{d.leaves.map((l) => (
            <div className="row" key={l.id}><div className="ri c-lv"><Icon n="leaf" /></div>
              <div className="t"><b>{cap(l.leave_type)}</b><span>{l.starts_on === l.ends_on ? fmtShortDay(new Date(l.starts_on)) : `${fmtShortDay(new Date(l.starts_on))} to ${fmtShortDay(new Date(l.ends_on))}`}</span></div>
              <span className={`chip ${STATUS_CHIP[l.status] ?? 'c-pend'}`}>{cap(l.status)}</span></div>))}</div></>)}

        <div className="sec">Location pattern · 7 check-ins</div>
        {!pat ? <Spin /> : (
          <div className="card row">{pat.same
            ? <><span className="ri c-bad"><Icon n="pin" /></span><span className="t"><b>Same pin every day</b><span>Likely a location changer app</span></span></>
            : <><span className="ri c-ok"><Icon n="pin" /></span><span className="t"><b>Natural variation</b><span>{pat.drift}</span></span></>}</div>
        )}
      </>)}

      <div className="sec">Details <button onClick={() => setSheet('edit')}>Edit</button></div>
      <div className="card"><dl className="kv" style={{ margin: 0 }}><dt>Designation</dt><dd>{p.designation ?? '—'}</dd><dt>Type</dt><dd>{cap(p.role)}</dd><dt>Email</dt><dd>{p.email}</dd><dt>Code</dt><dd>{p.employee_code ?? '—'}</dd><dt>Phone</dt><dd>{p.phone ?? '—'}</dd><dt>Status</dt><dd>{p.invited ? 'Invited' : active ? 'Active' : 'Inactive'}</dd></dl></div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
        <button className="btn light" onClick={() => setSheet('edit')}><Icon n="building" />Move hub or edit</button>
        {!p.invited && <button className="btn light" onClick={() => open({ name: 'long', p })}><Icon n="leaf" />Assign long leave</button>}
        {!p.invited && (active ? <button className="btn light" onClick={() => setSheet('deact')}>Deactivate</button>
          : <button className="btn light" onClick={async () => { await hr.setActive(p.id, true); setActive(true); toast('Reactivated'); }}>Reactivate</button>)}
        <button className="btn danger" onClick={() => setSheet('delete')}>Delete</button>
      </div>
    </div>
      {sheet === 'edit' && <EditStaff p={p} onClose={() => setSheet(null)} onSaved={(np, moved) => { setP(np); setSheet(null); toast(moved ? `${first} moved to ${np.hub} hub · told` : 'Saved'); }} />}
      {sheet === 'deact' && (<><div className="scrim" onClick={() => setSheet(null)} />
        <div className="sheet" role="dialog" aria-label="Deactivate"><div className="grab" /><h3>Deactivate {first}?</h3><p>Sign-in stops. Records stay.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 20 }}>
            <button className="btn danger" onClick={async () => { await hr.setActive(p.id, false); setActive(false); setSheet(null); toast('Deactivated'); }}>Deactivate</button>
            <button className="btn ghost" onClick={() => setSheet(null)}>Cancel</button></div></div></>)}
      {sheet === 'delete' && (<><div className="scrim" onClick={() => setSheet(null)} />
        <div className="sheet" role="dialog" aria-label="Delete"><div className="grab" /><h3>Delete {first}?</h3><p>For entries added by mistake. Anyone with attendance records can only be deactivated.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 20 }}>
            <button className="btn danger" onClick={del}>Delete</button>
            <button className="btn ghost" onClick={() => setSheet(null)}>Cancel</button></div></div></>)}
    </>
  );
}

// HR moves a person to another hub or fixes their details (roster -> profile by trigger; a hub move notifies the person)
function EditStaff({ p, onClose, onSaved }: { p: Person; onClose: () => void; onSaved: (p: Person, moved: boolean) => void }) {
  const [hubs, setHubs] = useState<Hub[] | null>(null);
  const [f, setF] = useState({ hub: p.hub ?? '', designation: p.designation ?? '', phone: p.phone ?? '', code: p.employee_code ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { hr.hubs().then((h) => setHubs(h.filter((x) => x.active))).catch(() => setHubs([])); }, []);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.hub) { setErr('Pick a hub.'); return; }
    setBusy(true); setErr(null);
    const moved = f.hub !== p.hub;
    try {
      await hr.updateStaff(p.email, { hub_name: f.hub, designation: f.designation, phone: f.phone, employee_code: f.code });
      onSaved({ ...p, hub: f.hub, designation: f.designation.trim() || null, phone: f.phone.trim() || null, employee_code: f.code.trim() || null }, moved);
    } catch (e) { setBusy(false); setErr(e instanceof ApiError && e.code.startsWith('code_taken:') ? `Code already used by ${e.code.slice(11)}.` : 'Could not save. Try again.'); }
  };
  return (<><div className="scrim" onClick={onClose} />
    <div className="sheet" role="dialog" aria-label={`Edit ${p.full_name}`}><div className="grab" />
      <div className="scrollable">
        <h3>{p.full_name}</h3><p>Hub moves apply from the next check-in.</p>
        <label className="lab" htmlFor="e-hub">Hub</label>
        <select className="inp" id="e-hub" value={f.hub} onChange={(e) => set('hub', e.target.value)}>
          <option value="" disabled>Pick a hub</option>{(hubs ?? []).map((h) => <option key={h.id} value={h.name}>{h.name}{h.name === p.hub ? ' · current' : ''}</option>)}</select>
        {f.hub && f.hub !== p.hub && <div className="note" style={{ marginTop: 8 }}><Icon n="building" size={16} />{p.hub ?? 'No hub'} → {f.hub}. {p.full_name.split(' ')[0]} gets a notification.</div>}
        <label className="lab" htmlFor="e-d">Designation</label>
        <input className="inp" id="e-d" list="designations-e" value={f.designation} onChange={(e) => set('designation', e.target.value)} placeholder="Pick or type" />
        <datalist id="designations-e">{DESIGNATIONS.map((d) => <option key={d} value={d} />)}</datalist>
        <div className="two">
          <div><label className="lab" htmlFor="e-p">Phone</label><input className="inp" id="e-p" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          <div><label className="lab" htmlFor="e-c">Code</label><input className="inp" id="e-c" value={f.code} onChange={(e) => set('code', e.target.value)} /></div>
        </div>
        {err && <div className="err">{err}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16 }}>
        <button className="btn dark" disabled={busy} onClick={save}>{busy ? 'Saving' : 'Save'}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button></div></div></>);
}

function ReturnSheet({ title, onClose, onReturn }: { title: string; onClose: () => void; onReturn: (reason: string) => Promise<void> }) {
  const [chip, setChip] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState(false);
  return (<><div className="scrim" onClick={onClose} />
    <div className="sheet" role="dialog" aria-label={title}><div className="grab" /><h3>{title}</h3><p>Pick a reason.</p>
      <div className="rchips">{['Dates clash', 'Need details', 'Short staffed', 'Other'].map((x) => <button key={x} className={chip === x ? 'on' : ''} onClick={() => { setChip(x); setErr(false); }}>{x}</button>)}</div>
      <input className="inp" style={{ marginTop: 14 }} placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {err && <div className="err">Pick a reason.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 18 }}>
        <button className="btn dark" onClick={async () => { if (!chip) { setErr(true); return; } await onReturn(note ? `${chip}: ${note}` : chip); }}>Return</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button></div></div></>);
}

function Approvals({ c, onChange }: { c: HrToday | null; onChange: () => void }) {
  const { toast } = useApp();
  const [tab, setTab] = useState<'leave' | 'od'>('leave');
  const [leaves, setLeaves] = useState<LeaveReq[] | null>(null);
  const [ods, setOds] = useState<OdReq[] | null>(null);
  const [ret, setRet] = useState<{ type: 'leave' | 'od'; id: string } | null>(null);
  const load = useCallback(() => { hr.leaves().then(setLeaves).catch(() => setLeaves([])); hr.ods().then(setOds).catch(() => setOds([])); }, []);
  useEffect(() => { load(); }, [load]);
  const away = !!c?.chairman_away;
  const decide = async (type: 'leave' | 'od', id: string, d: 'approved' | 'returned', reason?: string) => {
    try { await (type === 'leave' ? hr.decideLeave(id, d, reason) : hr.decideOd(id, d, reason)); toast(d === 'approved' ? 'Approved · staff notified' : 'Returned · staff notified'); setRet(null); load(); onChange(); }
    catch (e) { toast(e instanceof ApiError && /not allowed/i.test(e.code) ? 'Chairman is In. OD is with him.' : 'Could not save. Try again.'); }
  };
  const when = (a: string, b: string) => a === b ? fmtShortDay(new Date(a)) : `${fmtShortDay(new Date(a))} to ${fmtShortDay(new Date(b))}`;
  return (
    <><div className="scr fade">
      <Head small="Waiting on you" big="Approvals" />
      <div className="seg" role="group" aria-label="Type">
        <button className={tab === 'leave' ? 'on' : ''} onClick={() => setTab('leave')}>Leave {leaves?.length ?? ''}</button>
        <button className={tab === 'od' ? 'on' : ''} onClick={() => setTab('od')}>OD {ods?.length ?? ''}</button>
      </div>
      <div className="list" style={{ marginTop: 16 }}>
        {tab === 'leave' && (!leaves ? <Spin /> : leaves.length === 0 ? <div className="empty"><b>All clear</b>Nothing waiting here.</div> : leaves.map((r) => (
          <div className="req" key={r.id}>
            <div className="hd"><Av n={r.who} /><div className="t"><b>{r.who}</b><span>{r.hub ?? 'No hub'} hub</span></div><span className="chip c-lv">{cap(r.leave_type)}</span></div>
            {r.reason && <p className="bd">{r.reason}</p>}
            <div className="meta"><span className="chip c-pend"><Icon n="clock" size={14} />{when(r.starts_on, r.ends_on)}{r.half_day ? ` · ${r.half_day} half` : ''}</span></div>
            <div className="acts"><button className="btn light" onClick={() => setRet({ type: 'leave', id: r.id })}>Return</button><button className="btn dark" onClick={() => decide('leave', r.id, 'approved')}><Icon n="check" />Approve</button></div>
          </div>)))}
        {tab === 'od' && (<>
          <div className="note-hr"><Icon n="brief" size={16} />{away ? 'Chairman is Away. You approve OD.' : 'Chairman approves OD. View only.'}</div>
          {!ods ? <Spin /> : ods.length === 0 ? <div className="empty"><b>All clear</b>No OD waiting.</div> : ods.map((r) => {
            const quick = (new Date(r.starts_at).getTime() - new Date(r.created_at).getTime()) / 3.6e6 < 12;
            return (
              <div className="req" key={r.id} style={{ marginTop: 10 }}>
                <div className="hd"><Av n={r.who} /><div className="t"><b>{r.who}</b><span>{r.hub ?? 'No hub'} hub</span></div><span className={`chip ${quick ? 'c-warn' : 'c-od'}`}>{quick ? 'Quick' : 'OD'}</span></div>
                <p className="bd">{r.subject}</p>
                <div className="meta"><span className="chip c-pend">{fmtShortDay(new Date(r.starts_at))} · {fmtTime(r.starts_at)} to {fmtTime(r.ends_at)}</span></div>
                <VenueLink name={r.venue_name} place={r.venue_place} url={r.venue_url} lat={r.venue_lat} lng={r.venue_lng} />
                {away && <div className="acts"><button className="btn light" onClick={() => setRet({ type: 'od', id: r.id })}>Return</button><button className="btn dark" onClick={() => decide('od', r.id, 'approved')}><Icon n="check" />Approve</button></div>}
              </div>);
          })}
        </>)}
      </div>
    </div>
    {ret && <ReturnSheet title={ret.type === 'leave' ? 'Return leave' : 'Return OD'} onClose={() => setRet(null)} onReturn={(reason) => decide(ret.type, ret.id, 'returned', reason)} />}
    </>
  );
}

function flagLine(f: Flag) {
  if (f.kind === 'radius') return `${fmtDistance(f.punch?.distance_m ?? 0)} from ${f.hub ?? 'the'} hub${f.punch?.place_name ? ` · near ${f.punch.place_name}` : ''}`;
  if (f.kind === 'location_changer') return 'Same pin, day after day';
  if (f.kind === 'face') return `Face match ${Math.round(f.punch?.face_similarity ?? 0)}%`;
  if (f.staff_reason) return `“${f.staff_reason}”`;
  return f.rule;
}

function Disputes({ open }: { open: (s: Sub) => void }) {
  const [list, setList] = useState<Flag[] | null>(null);
  useEffect(() => { hr.flags().then(setList).catch(() => setList([])); }, []);
  return (
    <div className="scr fade">
      <Head small="Review" big="Disputes" />
      <div className="note-hr"><Icon n="lock" size={16} />Staff never see radius or spoof checks.</div>
      {!list ? <Spin /> : <div className="list">{list.map((f) => {
        const [label, cls] = FLAG_LABEL[f.kind] ?? [f.kind, 'c-pend'];
        return (
          <button key={f.id} className="req" style={{ width: '100%', textAlign: 'left', display: 'block' }} onClick={() => open({ name: 'dispute', f })}>
            <span className="hd"><Av n={f.who} /><span className="t"><b>{f.who}</b><span>{fmtShortDay(new Date(f.created_at))} · {fmtTime(f.created_at)}</span></span><span className={`chip ${cls}`}>{label}</span></span>
            <span className="bd" style={{ display: 'block' }}>{flagLine(f)}</span>
            <span className="meta" style={{ display: 'flex' }}><span className="chip c-pend">{f.staff_reason ? 'Staff note' : f.status === 'reason_asked' ? 'Reason asked' : 'Auto-detected'}</span></span>
          </button>);
      })}{list.length === 0 && <div className="empty"><b>No open disputes</b>New ones appear here.</div>}</div>}
    </div>
  );
}

function Sig({ l, v, c }: { l: string; v: string; c: string }) { return <div className="sig"><span>{l}</span><span className={`chip ${c}`}>{v}</span></div>; }

function DisputeView({ f, onBack }: { f: Flag; onBack: () => void }) {
  const { toast } = useApp();
  const [photo, setPhoto] = useState<string | null>(null);
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [place, setPlace] = useState<string | null>(f.punch?.place_name ?? null);
  useEffect(() => {
    hr.selfieUrl(f.punch?.selfie_key ?? null).then(setPhoto); hr.pins(f.user_id).then(setPins).catch(() => setPins([]));
    if (f.punch && !f.punch.place_name) placeLabel(f.punch.lat, f.punch.lng).then(setPlace);
  }, [f]);
  const [label] = FLAG_LABEL[f.kind] ?? [f.kind];
  const pu = f.punch, first = f.who.split(' ')[0];
  const q = pu?.quality_score ?? null;
  const act = async (fn: () => Promise<void>, msg: string) => { try { await fn(); toast(msg); onBack(); } catch { toast('Could not save. Try again.'); } };
  const accs = new Set(pins?.map((p) => p.accuracy_m));
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small={f.who} big={label} onBack={onBack} />
      <div className="shot">{photo ? <img src={photo} alt={`${f.who} check-in selfie`} /> : <div className="center" style={{ background: '#D9DCE3', color: 'var(--ph-ink3)', fontSize: 14 }}>No photo</div>}
        <div className="stamp">{f.who} · Check in<br />{pu ? `${fmtShortDay(new Date(pu.server_time))} · ${fmtTime(pu.server_time)} IST` : ''}<br />{place ?? ''} {pu ? `· ${pu.lat.toFixed(5)}°N ${pu.lng.toFixed(5)}°E` : ''}</div></div>
      {pu && <div className="card" style={{ marginTop: 12 }}>
        <div className="row"><span className="ri c-bad"><Icon n="pin" /></span>
          <span className="t" style={{ whiteSpace: 'normal' }}><b>Probable location</b><span style={{ whiteSpace: 'normal' }}>{place ?? 'Finding place name…'}</span></span></div>
        <dl className="kv" style={{ marginTop: 12 }}>
          {pu.distance_m != null && <><dt>From {f.hub ?? 'target'} hub</dt><dd>{fmtDistance(pu.distance_m)}</dd></>}
          <dt>Coordinates</dt><dd>{pu.lat.toFixed(5)}, {pu.lng.toFixed(5)}</dd>
          {pu.accuracy_m != null && <><dt>Accuracy</dt><dd>± {Math.round(pu.accuracy_m)} m</dd></>}
        </dl>
        <div className="two" style={{ marginTop: 12 }}>
          <a className="btn light" style={{ height: 44, fontSize: 14, textDecoration: 'none' }} href={googleMapsUrl(pu.lat, pu.lng)} target="_blank" rel="noreferrer">Google Maps</a>
          <a className="btn light" style={{ height: 44, fontSize: 14, textDecoration: 'none' }} href={appleMapsUrl(pu.lat, pu.lng)} target="_blank" rel="noreferrer">Apple Maps</a>
        </div></div>}
      {f.staff_reason && <div className="quote" style={{ marginTop: 12 }}><small>{first} says</small>“{f.staff_reason}”</div>}
      {q !== null && <div className="card" style={{ marginTop: 12 }}><div className="qhd"><span>Live data quality</span><b>{q}<small>/100</small></b></div>
        <div className="bar"><i style={{ width: `${q}%`, background: q >= 70 ? 'var(--ok)' : 'var(--bad)' }} /></div>
        <div className="qv" style={{ color: q >= 70 ? 'var(--ok-ink)' : 'var(--bad-ink)' }}>{q >= 70 ? 'Real GPS readings' : 'Readings look unnatural'}</div></div>}
      <div className="sec">Signals</div>
      <div className="card">
        <Sig l="Rule" v={f.rule.split(' ')[0]} c="c-pend" />
        {pu?.distance_m != null && <Sig l="Distance from target" v={pu.distance_m >= 1000 ? `${(pu.distance_m / 1000).toFixed(1)} km` : `${Math.round(pu.distance_m)} m`} c={f.kind === 'radius' ? 'c-bad' : 'c-ok'} />}
        {pu?.accuracy_m != null && <Sig l="GPS accuracy" v={`${Math.round(pu.accuracy_m)} m`} c={pu.accuracy_m <= 50 ? 'c-ok' : 'c-warn'} />}
        {pu?.face_similarity != null && <Sig l="Face match" v={`${Math.round(pu.face_similarity)}%`} c={pu.face_similarity >= 80 ? 'c-ok' : 'c-bad'} />}
        {pins && pins.length >= 3 && <Sig l="Accuracy values" v={accs.size === 1 ? 'Stuck' : 'Varying'} c={accs.size === 1 ? 'c-bad' : 'c-ok'} />}
      </div>
      {pins && pins.length > 0 && (<>
        <div className="sec">Last {pins.length} check-ins</div>
        <div className="card tblw"><table className="tbl"><thead><tr><th>Date</th><th>Lat, Lng</th><th>Acc.</th></tr></thead><tbody>
          {pins.map((p, i) => { const same = pins.filter((x) => x.lat === p.lat && x.lng === p.lng).length > 2;
            return <tr key={i}><td>{fmtShortDay(new Date(p.server_time))}</td><td className={same ? 'same' : ''}>{p.lat.toFixed(6)}, {p.lng.toFixed(6)}</td><td>{p.accuracy_m != null ? `${Math.round(p.accuracy_m)} m` : '—'}</td></tr>; })}
        </tbody></table><p className="cmp">Real GPS drifts 3 to 25 m a day.</p></div></>)}
      <div className="two" style={{ marginTop: 20 }}>
        <button className="btn light" onClick={() => act(() => hr.decideFlag(f.id, 'valid'), 'Marked valid')}>Valid</button>
        <button className="btn danger" onClick={() => act(() => hr.decideFlag(f.id, 'violation'), 'Marked violation')}>Violation</button>
      </div>
      {f.status !== 'reason_asked' && <button className="btn ghost" style={{ marginTop: 6 }} onClick={() => act(() => hr.askReason(f.id), `Asked ${first} for a reason`)}>Ask {first} for a reason</button>}
    </div>
  );
}

function Hubs({ onBack, open }: { onBack: () => void; open: (s: Sub) => void }) {
  const [list, setList] = useState<Hub[] | null>(null);
  useEffect(() => { hr.hubs().then(setList).catch(() => setList([])); }, []);
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small={`${list?.length ?? '–'} hubs`} big="Hubs" onBack={onBack} right={<button className="rbtn" onClick={() => open({ name: 'hub', h: null })} aria-label="Add hub"><Icon n="plus" /></button>} />
      {!list ? <Spin /> : <div className="list">{list.map((h) => (
        <button key={h.id} className="card row" onClick={() => open({ name: 'hub', h })}><span className={`ri ${h.maps_url ? 'c-ok' : 'c-warn'}`}><Icon n="building" /></span>
          <span className="t"><b>{h.name} hub</b><span>{h.staff ?? 0} staff · {h.radius_m} m radius{h.maps_url ? '' : ' · pin not set'}</span></span><Icon n="chevR" style={{ color: 'var(--ph-ink3)', width: 18 }} /></button>
      ))}</div>}
    </div>
  );
}

function HubEdit({ h, onBack }: { h: Hub | null; onBack: () => void }) {
  const { toast } = useApp();
  const [name, setName] = useState(h?.name ?? '');
  const [link, setLink] = useState(h?.maps_url ?? '');
  const [r, setR] = useState(String(h?.radius_m ?? 500));
  const [err, setErr] = useState<string | null>(null);
  const c = parseVenue(link);
  const px = ({ 300: 64, 500: 96, 800: 132 } as Record<string, number>)[r] ?? 96;
  const save = async () => {
    if (!name.trim()) { setErr('Add a name.'); return; }
    const coords = c ?? (h ? { lat: h.lat, lng: h.lng } : null);
    if (!coords) { setErr('Paste a full Google Maps link with the pin.'); return; }
    try { await hr.saveHub({ id: h?.id, name: name.trim(), lat: coords.lat, lng: coords.lng, radius_m: Number(r), maps_url: link || null }); toast('Hub saved'); onBack(); }
    catch { setErr('Could not save. Try again.'); }
  };
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small={h ? 'Edit' : 'New'} big={h ? `${h.name} hub` : 'Add hub'} onBack={onBack} />
      <div className="map"><div className="circ" style={{ width: px, height: px }} /><div className="pin"><Icon n="pin" /></div><div className="lb">{r} m radius</div></div>
      <label className="lab" htmlFor="h-n">Name</label><input className="inp" id="h-n" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hub name" />
      <label className="lab" htmlFor="h-l">Map link</label><input className="inp" id="h-l" value={link} onChange={(e) => { setLink(e.target.value); setErr(null); }} placeholder="Paste Google Maps link" />
      <p className="to" style={{ textAlign: 'left', margin: '8px 0 0' }}>{c ? `Pin: ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : h ? `Current pin: ${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}` : 'Long-press the spot in Google Maps, then copy the link.'}</p>
      <label className="lab">Radius</label>
      <div className="seg" role="group" aria-label="Radius">{['300', '500', '800'].map((x) => <button key={x} className={r === x ? 'on' : ''} onClick={() => setR(x)}>{x} m</button>)}</div>
      {err && <div className="err">{err}</div>}
      <button className="btn dark" style={{ marginTop: 22 }} onClick={save}>Save</button>
    </div>
  );
}

function AddStaff({ onBack }: { onBack: () => void }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', email: '', type: 'staff' as 'staff' | 'intern', designation: '', phone: '', joined: new Date().toISOString().slice(0, 10), hub: '', code: '' });
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { hr.hubs().then((h) => { setHubs(h); setF((x) => ({ ...x, hub: x.hub || h[0]?.name || '' })); }); }, []);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (f.name.trim().length < 2) e.name = 'Add a name.';
    if (!/^\S+@\S+\.\S+$/.test(f.email)) e.email = 'Add a valid email.';
    if (!f.designation.trim()) e.designation = 'Add a designation.';
    setErrs(e); if (Object.keys(e).length) return;
    try { await hr.addStaff({ full_name: f.name.trim(), email: f.email, role: f.type, designation: f.designation.trim(), hub_name: f.hub, phone: f.phone, joined_on: f.joined, employee_code: f.code }); toast(`${f.name.split(' ')[0]} added · can sign in now`); onBack(); }
    catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code.startsWith('already_added')) setErrs({ email: code.split(':')[1] ? `Already added as ${code.split(':')[1]}.` : 'This email is already added.' });
      else if (code.startsWith('code_taken')) setErrs({ code: `Code already used by ${code.split(':')[1]}.` });
      else setErrs({ email: errorText('save_failed') });
    }
  };
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="New" big="Add staff" onBack={onBack} />
      <label className="lab" htmlFor="a-n" style={{ marginTop: 0 }}>Full name</label><input className="inp" id="a-n" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Priya Raman" />{errs.name && <div className="err">{errs.name}</div>}
      <label className="lab" htmlFor="a-e">Email</label><input className="inp" id="a-e" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder={f.type === 'intern' ? 'personal@gmail.com' : 'name@startuptn.in'} />{errs.email && <div className="err">{errs.email}</div>}
      <label className="lab">Type</label>
      <div className="seg" role="group" aria-label="Type"><button className={f.type === 'staff' ? 'on' : ''} onClick={() => set('type', 'staff')}>Staff</button><button className={f.type === 'intern' ? 'on' : ''} onClick={() => { set('type', 'intern'); if (!f.designation) set('designation', 'Intern'); }}>Intern</button></div>
      <label className="lab" htmlFor="a-d">Designation</label>
      <input className="inp" id="a-d" list="designations" value={f.designation} onChange={(e) => set('designation', e.target.value)} placeholder="Pick or type" />
      <datalist id="designations">{DESIGNATIONS.map((d) => <option key={d} value={d} />)}</datalist>
      {errs.designation && <div className="err">{errs.designation}</div>}
      <div className="two">
        <div><label className="lab" htmlFor="a-ph">Phone</label><input className="inp" id="a-ph" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="98400 00000" /></div>
        <div><label className="lab" htmlFor="a-c">Code</label><input className="inp" id="a-c" value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="STN0150" />{errs.code && <div className="err">{errs.code}</div>}</div>
      </div>
      <div className="two">
        <div><label className="lab" htmlFor="a-j">Joining</label><input className="inp" id="a-j" type="date" value={f.joined} onChange={(e) => set('joined', e.target.value)} /></div>
        <div><label className="lab" htmlFor="a-h">Hub</label><select className="inp" id="a-h" value={f.hub} onChange={(e) => set('hub', e.target.value)}>{hubs.map((h) => <option key={h.id}>{h.name}</option>)}</select></div>
      </div>
      <p className="to">They sign in with a code sent to this email</p>
      <button className="btn dark" onClick={save}>Add staff</button>
    </div>
  );
}

function LongLeave({ p, onBack }: { p?: Person; onBack: () => void }) {
  const { toast } = useApp();
  const people = usePeople();
  const [who, setWho] = useState(p?.id ?? '');
  const [ty, setTy] = useState('maternity');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!who && people?.[0]) setWho(people[0].id); }, [people, who]);
  const save = async () => {
    if (!who || !to || to < from) { setErr('Pick the person and valid dates.'); return; }
    try { await hr.longLeave(who, ty, from, to); toast('Long leave added · staff notified'); onBack(); } catch { setErr('Could not save. Try again.'); }
  };
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Assign" big="Long leave" onBack={onBack} />
      <label className="lab" htmlFor="ll-w" style={{ marginTop: 0 }}>Staff</label>
      <select className="inp" id="ll-w" value={who} onChange={(e) => setWho(e.target.value)}>{(people ?? []).filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.full_name} · {x.hub ?? 'No hub'}</option>)}</select>
      <label className="lab">Type</label>
      <div className="seg" role="group" aria-label="Type">{['maternity', 'paternity', 'sabbatical'].map((x) => <button key={x} className={ty === x ? 'on' : ''} onClick={() => setTy(x)}>{cap(x)}</button>)}</div>
      <div className="two">
        <div><label className="lab" htmlFor="ll-f">From</label><input className="inp" id="ll-f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="lab" htmlFor="ll-t">To</label><input className="inp" id="ll-t" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {err && <div className="err">{err}</div>}
      <p className="to">No check-in or tracking during this period</p>
      <button className="btn dark" onClick={save}>Assign</button>
    </div>
  );
}

function NotifWrap({ onBack }: { onBack: () => void }) {
  // Reuse the staff notifications screen; its Back goes through the app context, so wrap with our own bar.
  return <div style={{ position: 'absolute', inset: 0 }}><Notifications onBackOverride={onBack} /></div>;
}
