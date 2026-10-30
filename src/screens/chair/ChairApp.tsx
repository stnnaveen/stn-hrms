import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App';
import { ApiError } from '../../lib/api';
import { chair, istMin, type LeaveItem, type OdItem, type Snapshot, type Staff } from '../../lib/chair';
import { hr, FLAG_LABEL, type Flag, type PersonDetail } from '../../lib/hr';
import { placeLabel, googleMapsUrl, appleMapsUrl, fmtDistance } from '../../lib/geo';
import { fmtDay, fmtShortDay, fmtTime, greeting } from '../../lib/time';
import { Icon, Logo } from '../../ui/Icon';
import { AccountSheet } from '../../ui/AccountSheet';
import { Notifications } from '../Notifications';
import { firstViewToday } from '../../device';

type Tab = 'home' | 'people' | 'approvals';
type ListKind = 'in' | 'late' | 'notin' | 'out' | 'od' | 'lv' | 'early' | 'last';
type Sub = { name: 'list'; kind: ListKind } | { name: 'hub'; hub: string } | { name: 'alerts' } | { name: 'alert'; f: Flag } | { name: 'notifs' };
type Sheet = null | { t: 'od'; o: OdItem } | { t: 'ret'; o: OdItem } | { t: 'person'; s: Staff } | { t: 'account' };

const TINTS = ['#3B4A6B', '#5B4AA8', '#2F62D9', '#1F7A55', '#9C3F5A', '#7A5A2E', '#4E5464'];
const tint = (s: string) => TINTS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
const ini = (n: string) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const Av = ({ n }: { n: string }) => <span className="av sm" style={{ background: tint(n), color: '#fff' }} aria-hidden="true">{ini(n)}</span>;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const LABELS: Record<ListKind, string> = { in: 'Checked in', late: 'Late', notin: 'Not in', out: 'Checked out', od: 'On OD', lv: 'On leave', early: 'Early out', last: 'Last out' };
const STC: Record<string, string> = { approved: 'c-ok', pending: 'c-pend', returned: 'c-bad', cancelled: 'c-pend' };

function Top({ small, big, onBack, right }: { small: string; big: string; onBack: () => void; right?: React.ReactNode }) {
  return <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>{small}</small><b>{big}</b></div>{right ?? <span className="sp" />}</div>;
}
function Head({ small, big }: { small: string; big: string }) {
  return <div style={{ marginBottom: 16 }}><small style={{ fontSize: 13, color: 'var(--ph-ink3)' }}>{small}</small><b style={{ display: 'block', fontSize: 26, fontWeight: 600, letterSpacing: '-.02em' }}>{big}</b></div>;
}
function Spin() { return <div className="center" style={{ height: 240 }}><span className="spin dark" /></div>; }
const quick = (o: OdItem) => (new Date(o.starts_at).getTime() - new Date(o.created_at).getTime()) / 3.6e6 < 12;
function when(o: { starts_at: string; ends_at: string }) {
  const a = new Date(o.starts_at), b = new Date(o.ends_at), h = (b.getTime() - a.getTime()) / 3.6e6;
  if (h >= 20) return `${fmtShortDay(a)} to ${fmtShortDay(b)}`;
  if (h >= 7.5) return `${fmtShortDay(a)} · Full day`;
  return `${fmtShortDay(a)} · ${fmtTime(o.starts_at)} to ${fmtTime(o.ends_at)}`;
}
function duration(o: { starts_at: string; ends_at: string }) {
  const h = (new Date(o.ends_at).getTime() - new Date(o.starts_at).getTime()) / 3.6e6;
  if (h >= 20) return `${Math.round(h / 24) || 1} days`;
  if (h >= 7.5) return 'Full day';
  return `${Math.floor(h)} h${Math.round((h % 1) * 60) ? ` ${Math.round((h % 1) * 60)} m` : ''}`;
}
function notice(o: OdItem) {
  const h = (new Date(o.starts_at).getTime() - new Date(o.created_at).getTime()) / 3.6e6;
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h)} h` : 'Under 1 h';
}
function statusChip(s: Staff) {
  if (s.cat === 'lv') return <span className="chip c-lv">{s.leaveType ? cap(s.leaveType) : 'Leave'}</span>;
  if (s.cat === 'notin') return <span className="chip c-pend">Not in</span>;
  if (s.cat === 'od') return <span className="chip c-od">OD</span>;
  if (s.early && s.outTime) return <span className="chip c-bad">Out {fmtTime(s.outTime)}</span>;
  return <span className={`chip ${s.band === 'ok' ? 'c-ok' : s.band === 'warn' ? 'c-warn' : 'c-bad'}`}>{fmtTime(s.inTime)}</span>;
}

// ---------------- app shell ----------------
export function ChairApp() {
  const { toast } = useApp();
  const [tab, setTab] = useState<Tab>('home');
  const [stack, setStack] = useState<Sub[]>([]);
  const [hub, setHub] = useState('All');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [ods, setOds] = useState<{ pending: OdItem[]; decided: OdItem[] } | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [aseg, setAseg] = useState<'od' | 'lv' | 'done'>('od');
  const [intro, setIntro] = useState(() => firstViewToday('chair-intro'));

  const load = useCallback(() => {
    chair.snapshot().then(setSnap).catch(() => toast('Could not load'));
    chair.ods().then(setOds).catch(() => setOds({ pending: [], decided: [] }));
  }, [toast]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const open = (s: Sub) => setStack((x) => [...x, s]);
  const back = () => setStack((x) => x.slice(0, -1));
  const setAway = async (a: boolean) => {
    if (!snap) return;
    setSnap({ ...snap, away: a });
    try { await chair.setAway(a); toast(a ? 'Away · OD goes to HR' : 'In · OD comes to you'); } catch { setSnap({ ...snap }); toast('Could not save'); }
  };
  const decide = async (o: OdItem, d: 'approved' | 'returned', reason?: string) => {
    try { await chair.decideOd(o.id, d, reason); setSheet(null); toast(`${d === 'approved' ? 'Approved' : 'Returned'} · ${o.who.split(' ')[0]} notified`); load(); }
    catch (e) { toast(e instanceof ApiError && /not allowed/i.test(e.code) ? 'Switch to In to decide OD.' : 'Could not save. Try again.'); }
  };

  const view = useMemo(() => (snap ? snap.staff.filter((s) => hub === 'All' || s.hub === hub) : []), [snap, hub]);
  if (intro && snap) return <Intro snap={snap} pending={ods?.pending.length ?? 0} onDone={() => setIntro(false)} />;

  const sub = stack[stack.length - 1];
  const sheets = <ChairSheets sheet={sheet} setSheet={setSheet} away={!!snap?.away} decide={decide} />;
  if (sub) {
    let body: React.ReactNode = null;
    if (sub.name === 'list') body = <ListView kind={sub.kind} staff={view} hub={hub} onBack={back} onKind={(k) => setStack((x) => [...x.slice(0, -1), { name: 'list', kind: k }])} onPerson={(s) => setSheet({ t: 'person', s })} />;
    if (sub.name === 'hub') body = <HubView hub={sub.hub} staff={snap?.staff ?? []} onBack={back} onPerson={(s) => setSheet({ t: 'person', s })} />;
    if (sub.name === 'alerts') body = <Alerts onBack={back} onOpen={(f) => open({ name: 'alert', f })} />;
    if (sub.name === 'alert') body = <AlertView f={sub.f} onBack={back} />;
    if (sub.name === 'notifs') body = <div style={{ position: 'absolute', inset: 0 }}><Notifications onBackOverride={back} /></div>;
    return <>{body}{sheets}</>;
  }
  const away = !!snap?.away, pend = ods?.pending.length ?? 0;
  const t = (k: Tab, icn: string, l: string, dot = false) => (
    <button className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-label={l} aria-current={tab === k ? 'page' : undefined}><Icon n={icn} /><span>{l}</span>{dot && <i className="dotb" />}</button>
  );
  return (
    <>
      {tab === 'home' && <Home snap={snap} view={view} hub={hub} setHub={setHub} ods={ods} open={open} setSheet={setSheet} setAway={setAway} goApprovals={(seg) => { setAseg(seg); setTab('approvals'); }} />}
      {tab === 'people' && <People snap={snap} hub={hub} setHub={setHub} open={open} onPerson={(s) => setSheet({ t: 'person', s })} />}
      {tab === 'approvals' && <Approvals seg={aseg} setSeg={setAseg} ods={ods} away={away} setAway={setAway} setSheet={setSheet} />}
      <nav className="tabs t3" aria-label="Main">{t('home', 'chart', 'Dashboard')}{t('people', 'users', 'People')}{t('approvals', 'inbox', 'Approvals', pend > 0 && !away)}</nav>
      {sheets}
    </>
  );
}

// ---------------- daily greeting (animated hub orbit, then counts) ----------------
function Intro({ snap, pending, onDone }: { snap: Snapshot; pending: number; onDone: () => void }) {
  const [phase, setPhase] = useState<'orbit' | 'welcome'>('orbit');
  const [k, setK] = useState(0);
  const inn = snap.staff.filter((s) => s.cat === 'in').length, late = snap.staff.filter((s) => s.band === 'warn' || s.band === 'bad').length;
  useEffect(() => { const a = setTimeout(() => setPhase('welcome'), 2800); const b = setTimeout(onDone, 6400); return () => { clearTimeout(a); clearTimeout(b); }; }, [onDone]);
  useEffect(() => {
    if (phase !== 'welcome') return;
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => { const p = Math.min(1, (t - t0) / 1100); setK(1 - Math.pow(1 - p, 3)); if (p < 1) raf = requestAnimationFrame(step); };
    const s = setTimeout(() => { raf = requestAnimationFrame(step); }, 600);
    return () => { clearTimeout(s); cancelAnimationFrame(raf); };
  }, [phase]);
  if (phase === 'orbit') {
    const R = 112, RL = 138, c = 150, hubs = snap.hubs.length ? snap.hubs : ['Chennai'];
    return (
      <div className="csplash" role="button" tabIndex={0} onClick={() => setPhase('welcome')} aria-label="StartupTN HR. Tap to continue">
        <div className="halo" />
        <div className="orbit" aria-hidden="true"><div className="ra" /><div className="sweep" /><div className="rb" />
          {hubs.map((h, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / hubs.length;
            return <span key={h}><span className="hd2" style={{ left: c + R * Math.cos(a), top: c + R * Math.sin(a), animationDelay: `${0.35 + i * 0.12}s` }} />
              <span className="hl" style={{ left: c + RL * Math.cos(a), top: c + RL * Math.sin(a), animationDelay: `${0.4 + i * 0.12}s` }}>{h}</span></span>; })}
          <div className="core"><Logo size={78} /></div></div>
        <div className="nm">StartupTN <span className="grad" style={{ fontStyle: 'normal' }}>HR</span></div>
        <div className="tl">Every hub. One glance.</div>
        <div className="st"><span>{hubs.length} hubs</span><span>Live attendance</span><span>Chairman</span></div>
      </div>
    );
  }
  return (
    <div className="welcome" role="button" tabIndex={0} onClick={onDone} aria-label="Continue">
      <div className="glow" />
      <div className="w1">{fmtDay()}</div>
      <div className="w2">{greeting()},<br />Chairman.</div>
      <div className="w3">{istMin(new Date().toISOString()) >= 1080 ? 'Here is how today went.' : 'Have a great day.'}</div>
      <div className="cnt"><div><b>{Math.round(inn * k)}</b><span>Checked in</span></div><div><b>{Math.round(late * k)}</b><span>Late</span></div><div><b>{Math.round(pending * k)}</b><span>OD for you</span></div></div>
      <div className="skip">Tap to continue</div>
    </div>
  );
}

// ---------------- dashboard ----------------
function StatusRow({ away, setAway, style }: { away: boolean; setAway: (a: boolean) => void; style?: React.CSSProperties }) {
  return (
    <div className="card row" style={style}>
      <span className={`ri ${away ? 'c-pend' : 'c-ok'}`}><Icon n={away ? 'moon' : 'check'} /></span>
      <span className="t"><b>{away ? 'Away' : 'In'}</b><span>{away ? 'New OD goes to HR' : 'You approve OD'}</span></span>
      <div className="mseg" role="group" aria-label="Your status">
        <button className={away ? '' : 'on'} aria-pressed={!away} onClick={() => setAway(false)}>In</button>
        <button className={away ? 'on' : ''} aria-pressed={away} onClick={() => setAway(true)}>Away</button>
      </div>
    </div>
  );
}

function OdCard({ o, away, onOpen, onReturn, onApprove }: { o: OdItem; away: boolean; onOpen: () => void; onReturn: () => void; onApprove: () => void }) {
  return (
    <div className="req" role="button" tabIndex={0} onClick={onOpen} style={{ cursor: 'pointer' }}>
      <div className="hd"><Av n={o.who} /><div className="t"><b>{o.who}</b><span>{o.hub} hub</span></div>{quick(o) ? <span className="chip c-warn">Quick</span> : <span className="chip c-od">OD</span>}</div>
      <p className="bd">{o.subject}</p>
      <div className="meta"><span className="chip c-od"><Icon n="pin" size={14} />{o.venue.slice(0, 34)}</span><span className="chip c-pend">{when(o)}</span></div>
      {away ? <div className="to" style={{ margin: '12px 0 0' }}>Routed to HR while you’re away</div>
        : <div className="acts" onClick={(e) => e.stopPropagation()}><button className="btn light" onClick={onReturn}>Return</button><button className="btn dark" onClick={onApprove}><Icon n="check" />Approve</button></div>}
    </div>
  );
}

function trendSVG(v: { day: string; pct: number }[]) {
  if (v.length < 2) return <p className="more" style={{ margin: 0, textAlign: 'left' }}>Trend appears after a few days of check-ins.</p>;
  const W = 320, H = 110, lo = Math.min(80, ...v.map((x) => x.pct)), hi = 100;
  const x = (i: number) => 8 + (i * (W - 16)) / (v.length - 1), y = (p: number) => H - 12 - ((p - lo) / (hi - lo)) * (H - 24);
  const line = v.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.pct).toFixed(1)}`).join(' ');
  const last = v[v.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`On-time rate over ${v.length} days, now ${last.pct}%`}>
      <defs><linearGradient id="tf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FF4D5E" stopOpacity=".22" /><stop offset="1" stopColor="#FF4D5E" stopOpacity="0" /></linearGradient>
        <linearGradient id="tl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#FFA24A" /><stop offset="1" stopColor="#FF4D5E" /></linearGradient></defs>
      {[90, lo].map((g) => <g key={g}><line x1="8" x2={W - 8} y1={y(g)} y2={y(g)} stroke="#E2E3E7" /><text x={W - 8} y={y(g) - 4} textAnchor="end" fontSize="10" fill="#6B7080">{g}%</text></g>)}
      <path d={`${line} L${x(v.length - 1)} ${H} L${x(0)} ${H} Z`} fill="url(#tf)" />
      <path d={line} fill="none" stroke="url(#tl)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(v.length - 1)} cy={y(last.pct)} r="4.5" fill="#FF4D5E" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

function Home({ snap, view, hub, setHub, ods, open, setSheet, setAway, goApprovals }: {
  snap: Snapshot | null; view: Staff[]; hub: string; setHub: (h: string) => void; ods: { pending: OdItem[]; decided: OdItem[] } | null;
  open: (s: Sub) => void; setSheet: (s: Sheet) => void; setAway: (a: boolean) => void; goApprovals: (seg: 'od' | 'lv' | 'done') => void;
}) {
  if (!snap) return <div className="scr"><Spin /></div>;
  const evening = istMin(new Date().toISOString()) >= 1080;
  const inn = view.filter((s) => s.cat === 'in'), late = inn.filter((s) => s.band === 'warn' || s.band === 'bad');
  const notin = view.filter((s) => s.cat === 'notin'), outs = view.filter((s) => s.outTime).sort((a, b) => (b.outTime ?? '').localeCompare(a.outTime ?? ''));
  const still = inn.filter((s) => !s.outTime), early = view.filter((s) => s.early);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const decidedToday = (ods?.decided ?? []).filter((o) => o.decided_role === 'chairman' && (o.decided_at ?? '').slice(0, 10) === today);
  const hubsPct = snap.hubs.map((h) => { const ss = snap.staff.filter((s) => s.hub === h && s.cat === 'in'); return [h, ss.length ? Math.round((ss.filter((s) => s.band === 'ok').length / ss.length) * 100) : null] as const; });
  return (
    <div className="scr fade">
      <div className="hdr"><button className="av me" onClick={() => setSheet({ t: 'account' })} aria-label="Chairman account and log out">CH</button><div className="r">
        <button className="rbtn" onClick={() => open({ name: 'alerts' })} aria-label="Dispute alerts"><Icon n="flag" /></button>
        <button className="rbtn" onClick={() => open({ name: 'notifs' })} aria-label="Notifications"><Icon n="bell" /></button></div></div>
      <div className="pillrow" style={{ marginTop: 0 }} role="group" aria-label="Hub">{['All', ...snap.hubs].map((h) => <button key={h} className={`pill ${hub === h ? 'on' : ''}`} onClick={() => setHub(h)}>{h === 'All' ? 'All hubs' : h}</button>)}</div>
      <div className="dark">
        <div className="top"><div><div className="hi">{greeting()}, Chairman</div><div className="day">{hub === 'All' ? 'All hubs' : `${hub} hub`}</div></div><span className="live"><i />Live</span></div>
        <div className="gcard gc4">
          <button onClick={() => open({ name: 'list', kind: 'in' })}><small>Checked in</small><b>{inn.length}</b><em>of {view.length}</em></button>
          <button onClick={() => open({ name: 'list', kind: 'late' })}><small>Late</small><b>{late.length}</b><em>after 10</em></button>
          <button onClick={() => open({ name: 'list', kind: 'notin' })}><small>Not in</small><b>{notin.length}</b><em>{evening ? 'absent' : 'yet'}</em></button>
          <button onClick={() => open({ name: 'list', kind: 'out' })}><small>Checked out</small><b>{outs.length}</b><em>{evening ? `${still.length} still in` : 'from 6 PM'}</em></button>
        </div>
      </div>

      <div className="sec">OD for you · {ods?.pending.length ?? 0} <button onClick={() => goApprovals('od')}>See all</button></div>
      <div className="list">{!ods ? <Spin /> : ods.pending.length === 0 ? <div className="card empty" style={{ padding: 24 }}><b>All clear</b>No OD waiting.</div>
        : ods.pending.slice(0, 2).map((o) => <OdCard key={o.id} o={o} away={snap.away} onOpen={() => setSheet({ t: 'od', o })} onReturn={() => setSheet({ t: 'ret', o })} onApprove={() => setSheet({ t: 'od', o })} />)}</div>
      {decidedToday.length > 0 && <button className="card row" style={{ marginTop: 10, width: '100%' }} onClick={() => goApprovals('done')}><span className="ri c-ok"><Icon n="check" /></span>
        <span className="t"><b>Decided today · {decidedToday.length}</b><span>{decidedToday.filter((d) => d.status === 'approved').length} approved · {decidedToday.filter((d) => d.status === 'returned').length} returned</span></span><Icon n="chevR" style={{ color: 'var(--ph-ink3)' }} /></button>}
      <StatusRow away={snap.away} setAway={setAway} style={{ marginTop: 10 }} />

      <div className="sec">Today</div>
      <div className="grid2">
        <button className="mt" onClick={() => open({ name: 'list', kind: 'od' })}><span className="lb"><i style={{ background: 'var(--od)' }} />On OD</span><b>{view.filter((s) => s.cat === 'od').length}</b><span className="s">Approved for today</span></button>
        <button className="mt" onClick={() => open({ name: 'list', kind: 'lv' })}><span className="lb"><i style={{ background: 'var(--lv)' }} />On leave</span><b>{view.filter((s) => s.cat === 'lv').length}</b><span className="s">Approved by HR</span></button>
        <button className="mt" onClick={() => open({ name: 'list', kind: 'early' })}><span className="lb"><i style={{ background: 'var(--bad)' }} />Early out</span><b>{early.length}</b><span className="s">Before 6:00 PM</span></button>
        <button className="mt" onClick={() => open({ name: 'list', kind: 'last' })}><span className="lb"><i style={{ background: 'var(--ph-navy)' }} />Last out</span><b className="sm">{outs[0] ? fmtTime(outs[0].outTime) : '—'}</b><span className="s">{outs[0] ? `${outs[0].name} · ${still.length} still in` : 'No checkouts yet'}</span></button>
      </div>

      <div className="sec">On time · last 30 days</div>
      <div className="card trend">{trendSVG(snap.trend)}</div>

      <div className="sec">By hub · today</div>
      <div className="card">{hubsPct.map(([h, pct]) => (
        <button key={h} className={`hubrow ${hub === h ? 'on' : ''}`} onClick={() => setHub(hub === h ? 'All' : h)}>
          <span>{h}</span><span className="bar" style={{ display: 'block' }}><i style={{ width: `${pct ?? 0}%`, background: pct == null ? '#E2E3E7' : pct >= 90 ? 'var(--ok)' : pct >= 80 ? 'var(--warn)' : 'var(--bad)' }} /></span><b>{pct == null ? '—' : `${pct}%`}</b>
        </button>))}</div>
    </div>
  );
}

// ---------------- lists ----------------
function ListView({ kind, staff, hub, onBack, onKind, onPerson }: { kind: ListKind; staff: Staff[]; hub: string; onBack: () => void; onKind: (k: ListKind) => void; onPerson: (s: Staff) => void }) {
  const row = (s: Staff, sub: string, right: React.ReactNode) => <button key={s.id} className="lrow" onClick={() => onPerson(s)}><Av n={s.name} /><span className="t"><b>{s.name}</b><span>{sub}</span></span><span className="v">{right}</span></button>;
  let rows: React.ReactNode[] = [];
  const inn = staff.filter((s) => s.cat === 'in');
  switch (kind) {
    case 'in': rows = [...inn].sort((a, b) => (a.inTime ?? '').localeCompare(b.inTime ?? '')).map((s) => row(s, `${s.hub} hub`, statusChip(s))); break;
    case 'late': rows = inn.filter((s) => s.band !== 'ok').sort((a, b) => (b.inTime ?? '').localeCompare(a.inTime ?? '')).map((s) => row(s, `${s.hub} hub`, statusChip(s))); break;
    case 'notin': rows = staff.filter((s) => s.cat === 'notin').map((s) => row(s, `${s.hub} hub`, <span className="chip c-pend">Not in</span>)); break;
    case 'out': rows = staff.filter((s) => s.outTime).sort((a, b) => (b.outTime ?? '').localeCompare(a.outTime ?? '')).map((s) => row(s, `${s.hub} hub`, <span className={`chip ${s.early ? 'c-bad' : 'c-pend'}`}>{fmtTime(s.outTime)}</span>)); break;
    case 'od': rows = staff.filter((s) => s.cat === 'od').map((s) => row(s, s.od ? `${s.od.subject} · ${s.od.venue}` : `${s.hub} hub`, <span className="chip c-od">{s.od ? fmtTime(s.od.starts_at) : 'OD'}</span>)); break;
    case 'lv': rows = staff.filter((s) => s.cat === 'lv').map((s) => row(s, `${s.hub} hub`, <span className="chip c-lv">{s.leaveType ? cap(s.leaveType) : 'Leave'}</span>)); break;
    case 'early': rows = staff.filter((s) => s.early).sort((a, b) => (a.outTime ?? '').localeCompare(b.outTime ?? '')).map((s) => row(s, `${s.hub} hub`, <span className="chip c-bad">{fmtTime(s.outTime)}</span>)); break;
    case 'last': rows = [...inn.filter((s) => !s.outTime).map((s) => row(s, `${s.hub} hub`, <span className="chip c-ok">Still in</span>)),
      ...staff.filter((s) => s.outTime).sort((a, b) => (b.outTime ?? '').localeCompare(a.outTime ?? '')).map((s) => row(s, `${s.hub} hub`, <span className="chip c-pend">{fmtTime(s.outTime)}</span>))]; break;
  }
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small={hub === 'All' ? 'All hubs' : `${hub} hub`} big={LABELS[kind]} onBack={onBack} />
      <div className="pillrow" style={{ marginTop: 0 }} role="group" aria-label="Filter">{(Object.keys(LABELS) as ListKind[]).map((k) => <button key={k} className={`pill ${kind === k ? 'on' : ''}`} onClick={() => onKind(k)}>{LABELS[k]}</button>)}</div>
      {rows.length ? rows : <div className="empty"><b>No one here</b>Check back later.</div>}
    </div>
  );
}

// ---------------- people ----------------
function hubStats(staff: Staff[]) {
  const inn = staff.filter((s) => s.cat === 'in'), late = inn.filter((s) => s.band !== 'ok').length;
  return { n: staff.length, inn: inn.length, late, notin: staff.filter((s) => s.cat === 'notin').length, away: staff.filter((s) => s.cat === 'od' || s.cat === 'lv').length, ot: inn.length ? Math.round(((inn.length - late) / inn.length) * 100) : null };
}
function People({ snap, hub, setHub, open, onPerson }: { snap: Snapshot | null; hub: string; setHub: (h: string) => void; open: (s: Sub) => void; onPerson: (s: Staff) => void }) {
  const [seg, setSeg] = useState<'hubs' | 'emp'>('hubs');
  const [q, setQ] = useState('');
  const [f, setF] = useState('All');
  if (!snap) return <div className="scr"><Spin /></div>;
  const list = snap.staff.filter((s) => (hub === 'All' || s.hub === hub) && (!q || s.name.toLowerCase().includes(q.toLowerCase())))
    .filter((s) => f === 'All' || (f === 'Late' && s.band && s.band !== 'ok') || (f === 'Not in' && s.cat === 'notin') || (f === 'OD' && s.cat === 'od') || (f === 'Leave' && s.cat === 'lv'))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="scr fade">
      <Head small={`${snap.staff.length} people · ${snap.hubs.length} hubs`} big="People" />
      <div className="seg" role="group" aria-label="View" style={{ marginBottom: 16 }}><button className={seg === 'hubs' ? 'on' : ''} onClick={() => setSeg('hubs')}>Hubs</button><button className={seg === 'emp' ? 'on' : ''} onClick={() => setSeg('emp')}>Employees</button></div>
      {seg === 'hubs' ? snap.hubs.map((h) => { const x = hubStats(snap.staff.filter((s) => s.hub === h));
        return (
          <button key={h} className="hubc" onClick={() => open({ name: 'hub', hub: h })}>
            <span className="hh"><b>{h}</b><span>{x.n} staff{x.ot != null ? ` · ${x.ot}% on time` : ''}</span></span>
            <span className="nums"><span><b>{x.inn}</b><span>In</span></span><span><b>{x.late}</b><span>Late</span></span><span><b>{x.notin}</b><span>Not in</span></span><span><b>{x.away}</b><span>OD · Leave</span></span></span>
            <span className="bar" style={{ display: 'block' }}><i style={{ width: `${x.ot ?? 0}%`, background: x.ot == null ? '#E2E3E7' : x.ot >= 90 ? 'var(--ok)' : x.ot >= 80 ? 'var(--warn)' : 'var(--bad)' }} /></span>
          </button>); })
        : (<>
          <div className="pillrow" style={{ marginTop: 0 }} role="group" aria-label="Hub">{['All', ...snap.hubs].map((h) => <button key={h} className={`pill ${hub === h ? 'on' : ''}`} onClick={() => setHub(h)}>{h === 'All' ? 'All hubs' : h}</button>)}</div>
          <label className="search" htmlFor="cq"><Icon n="search" /><input id="cq" placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search employees" /></label>
          <div className="pillrow" role="group" aria-label="Status">{['All', 'Late', 'Not in', 'OD', 'Leave'].map((k) => <button key={k} className={`pill ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{k}</button>)}</div>
          <p className="more" style={{ margin: '0 0 10px', textAlign: 'left' }}>{list.length} people · {hub === 'All' ? 'all hubs' : hub}</p>
          {list.map((s) => <button key={s.id} className="lrow" onClick={() => onPerson(s)}><Av n={s.name} /><span className="t"><b>{s.name}</b><span>{s.designation ?? 'Staff'} · {s.hub}</span></span><span className="v">{statusChip(s)}</span></button>)}
          {list.length === 0 && <div className="empty"><b>No match</b>Try another name.</div>}
        </>)}
    </div>
  );
}

function HubView({ hub, staff, onBack, onPerson }: { hub: string; staff: Staff[]; onBack: () => void; onPerson: (s: Staff) => void }) {
  const ss = staff.filter((s) => s.hub === hub).sort((a, b) => a.name.localeCompare(b.name)), x = hubStats(ss);
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Hub" big={hub} onBack={onBack} />
      <div className="dark"><div className="top"><div><div className="hi">{x.n} staff</div><div className="day">{x.ot != null ? `${x.ot}% on time` : 'No check-ins yet'}</div></div><span className="live"><i />Live</span></div>
        <div className="gcard"><span><small>In</small><b>{x.inn}</b><em>{x.late} late</em></span><span><small>Not in</small><b>{x.notin}</b><em>today</em></span><span><small>OD · Leave</small><b>{x.away}</b><em>approved</em></span></div></div>
      <div className="sec">Staff</div>
      {ss.map((s) => <button key={s.id} className="lrow" onClick={() => onPerson(s)}><Av n={s.name} /><span className="t"><b>{s.name}</b><span>{s.outTime ? `Out ${fmtTime(s.outTime)}` : s.cat === 'in' ? 'In office' : s.designation ?? ''}</span></span><span className="v">{statusChip(s)}</span></button>)}
      {ss.length === 0 && <div className="empty"><b>No staff yet</b>HR adds people to this hub.</div>}
    </div>
  );
}

// ---------------- approvals ----------------
function Approvals({ seg, setSeg, ods, away, setAway, setSheet }: { seg: 'od' | 'lv' | 'done'; setSeg: (s: 'od' | 'lv' | 'done') => void; ods: { pending: OdItem[]; decided: OdItem[] } | null; away: boolean; setAway: (a: boolean) => void; setSheet: (s: Sheet) => void }) {
  const [leaves, setLeaves] = useState<LeaveItem[] | null>(null);
  useEffect(() => { chair.leaves().then(setLeaves).catch(() => setLeaves([])); }, []);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const dec = ods?.decided ?? [];
  const decRow = (o: OdItem) => (
    <button key={o.id} className="lrow" onClick={() => setSheet({ t: 'od', o })}><Av n={o.who} /><span className="t"><b>{o.who}</b><span>{o.subject} · {o.decided_role === 'hr' ? 'HR · you were away' : 'You'}</span></span>
      <span className="v"><span className={`chip ${o.status === 'approved' ? 'c-ok' : 'c-bad'}`}>{cap(o.status)}</span><span style={{ display: 'block', marginTop: 4 }}>{(o.decided_at ?? '').slice(0, 10) === today ? fmtTime(o.decided_at) : fmtShortDay(new Date(o.decided_at ?? o.created_at))}</span></span></button>
  );
  return (
    <div className="scr fade">
      <Head small="Requests" big="Approvals" />
      <div className="seg" role="group" aria-label="Type" style={{ marginBottom: 16 }}>
        <button className={seg === 'od' ? 'on' : ''} onClick={() => setSeg('od')}>OD · {ods?.pending.length ?? 0}</button>
        <button className={seg === 'lv' ? 'on' : ''} onClick={() => setSeg('lv')}>Leave · {leaves?.filter((l) => l.status === 'pending').length ?? 0}</button>
        <button className={seg === 'done' ? 'on' : ''} onClick={() => setSeg('done')}>Approved</button>
      </div>
      {seg === 'od' && (<>
        <StatusRow away={away} setAway={setAway} style={{ marginBottom: 12 }} />
        <div className="list">{!ods ? <Spin /> : ods.pending.length === 0 ? <div className="empty"><b>All clear</b>No OD waiting.</div>
          : ods.pending.map((o) => <OdCard key={o.id} o={o} away={away} onOpen={() => setSheet({ t: 'od', o })} onReturn={() => setSheet({ t: 'ret', o })} onApprove={() => setSheet({ t: 'od', o })} />)}</div>
      </>)}
      {seg === 'lv' && (<>
        <div className="note-hr"><Icon n="eye" size={16} />HR approves leave. View only.</div>
        {!leaves ? <Spin /> : leaves.length === 0 ? <div className="empty"><b>No leave</b>Nothing in the last 30 days.</div> : leaves.map((l) => (
          <div className="req" key={l.id} style={{ marginBottom: 10 }}>
            <div className="hd"><Av n={l.who} /><div className="t"><b>{l.who}</b><span>{l.hub} hub</span></div><span className="chip c-lv">{cap(l.leave_type)}</span></div>
            {l.reason && <p className="bd">{l.reason}</p>}
            <div className="meta"><span className="chip c-pend">{l.starts_on === l.ends_on ? fmtShortDay(new Date(l.starts_on)) : `${fmtShortDay(new Date(l.starts_on))} to ${fmtShortDay(new Date(l.ends_on))}`}</span>
              <span className={`chip ${STC[l.status] ?? 'c-pend'}`}>{l.status === 'pending' ? 'With HR' : l.assigned_by_hr ? 'Assigned by HR' : `${cap(l.status)} by HR`}</span></div>
          </div>))}
      </>)}
      {seg === 'done' && (<>
        <div className="card"><div className="ft" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
          <div><b>{dec.filter((d) => d.status === 'approved').length}</b><span>Approved</span></div><div><b>{dec.filter((d) => d.status === 'returned').length}</b><span>Returned</span></div><div><b>{ods?.pending.length ?? 0}</b><span>Waiting</span></div></div></div>
        <div className="dlist">
          {dec.some((o) => (o.decided_at ?? '').slice(0, 10) === today) && <><div className="sec">Today</div>{dec.filter((o) => (o.decided_at ?? '').slice(0, 10) === today).map(decRow)}</>}
          <div className="sec">Earlier · 30 days</div>{dec.filter((o) => (o.decided_at ?? '').slice(0, 10) !== today).map(decRow)}
          {dec.length === 0 && <div className="empty"><b>Nothing yet</b>Decisions appear here.</div>}
        </div>
      </>)}
    </div>
  );
}

// ---------------- sheets: OD detail, return, person ----------------
function ChairSheets({ sheet, setSheet, away, decide }: { sheet: Sheet; setSheet: (s: Sheet) => void; away: boolean; decide: (o: OdItem, d: 'approved' | 'returned', reason?: string) => Promise<void> }) {
  const [chip, setChip] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setChip(null); setErr(false); setBusy(false); }, [sheet]);
  if (!sheet) return null;
  const close = () => setSheet(null);
  if (sheet.t === 'account') return <AccountSheet name="Chairman" sub="Chairman · All hubs" onClose={close} />;
  if (sheet.t === 'person') return <PersonSheet s={sheet.s} onClose={close} />;
  const o = sheet.o, pending = o.status === 'pending';
  if (sheet.t === 'ret') return (<><div className="scrim" onClick={close} />
    <div className="sheet" role="dialog" aria-label="Return OD"><div className="grab" /><h3>Return OD</h3><p>Pick a reason.</p>
      <div className="rchips">{['Send someone else', 'Need details', 'Reschedule', 'Not needed'].map((x) => <button key={x} className={chip === x ? 'on' : ''} onClick={() => { setChip(x); setErr(false); }}>{x}</button>)}</div>
      {err && <div className="err">Pick a reason.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 18 }}>
        <button className="btn dark" disabled={busy} onClick={async () => { if (!chip) { setErr(true); return; } setBusy(true); await decide(o, 'returned', chip); }}>Return</button>
        <button className="btn ghost" onClick={close}>Cancel</button></div></div></>);
  return (<><div className="scrim" onClick={close} />
    <div className="sheet" role="dialog" aria-label="OD request"><div className="grab" />
      <div className="row"><Av n={o.who} /><div className="t"><b style={{ fontSize: 18 }}>{o.who}</b><span>{o.hub} hub</span></div>
        {pending ? (quick(o) ? <span className="chip c-warn">Quick</span> : <span className="chip c-od">OD</span>) : <span className={`chip ${o.status === 'approved' ? 'c-ok' : 'c-bad'}`}>{cap(o.status)}</span>}</div>
      <h3 style={{ marginTop: 16 }}>{o.subject}</h3>{o.note && <p>{o.note}</p>}
      <div className="odk"><dl className="kv">
        <dt>Venue</dt><dd>{o.venue}</dd><dt>When</dt><dd>{when(o)}</dd><dt>Duration</dt><dd>{duration(o)}</dd>
        <dt>Requested</dt><dd>{fmtShortDay(new Date(o.created_at))} · {fmtTime(o.created_at)}</dd><dt>Notice</dt><dd>{notice(o)}{quick(o) ? ' · quick' : ''}</dd>
        {!pending && <><dt>Decided</dt><dd>{o.decided_role === 'hr' ? 'HR · you were away' : 'You'} · {fmtShortDay(new Date(o.decided_at ?? o.created_at))}</dd>{o.return_reason && <><dt>Reason</dt><dd>{o.return_reason}</dd></>}</>}
      </dl></div>
      {pending && !away && <><p className="to" style={{ margin: '12px 0 0' }}>Selfie at the venue on check-in.</p>
        <div className="two" style={{ marginTop: 14 }}><button className="btn light" onClick={() => setSheet({ t: 'ret', o })}>Return</button>
          <button className="btn dark" disabled={busy} onClick={async () => { setBusy(true); await decide(o, 'approved'); }}><Icon n="check" />Approve</button></div></>}
      {pending && away && <p className="to" style={{ margin: '12px 0 0' }}>You’re Away. HR decides this one. Switch to In to decide.</p>}
      <button className="btn ghost" style={{ marginTop: 6 }} onClick={close}>{pending ? 'Later' : 'Close'}</button></div></>);
}

function PersonSheet({ s, onClose }: { s: Staff; onClose: () => void }) {
  const [d, setD] = useState<PersonDetail | null>(null);
  const [photos, setPhotos] = useState<Record<string, string | null>>({});
  useEffect(() => {
    hr.personDetail(s.id).then(async (x) => { setD(x); const u: Record<string, string | null> = {}; for (const p of x.punches) u[p.kind] = await hr.selfieUrl(p.selfie_key); setPhotos(u); }).catch(() => setD({ punches: [], days: [], ods: [], leaves: [] }));
  }, [s.id]);
  const month = d ? { on: d.days.filter((x) => x.band === 'ok' || x.status === 'od').length, late: d.days.filter((x) => x.band === 'warn' || x.band === 'bad').length, early: d.days.filter((x) => x.early_out).length } : null;
  const tile = (k: 'in' | 'out') => {
    const p = d?.punches.find((x) => x.kind === k);
    const t = k === 'in' ? s.inTime : s.outTime;
    if (!p) return <div className="ph none">{t ? `${k === 'in' ? 'In' : 'Out'} · ${fmtTime(t)}` : k === 'in' ? 'No check-in' : s.cat === 'in' ? 'Still in office' : 'Not checked out'}</div>;
    return <div className="ph">{photos[k] ? <img src={photos[k]!} alt={`${s.name} check-${k}`} /> : <div className="center" style={{ background: '#D9DCE3', color: 'var(--ph-ink3)', fontSize: 12 }}>Photo</div>}<div className="stamp">{k === 'in' ? 'In' : 'Out'} · {fmtTime(p.server_time)}<br />{p.place_name ?? `${s.hub} hub area`}</div></div>;
  };
  return (<><div className="scrim" onClick={onClose} />
    <div className="sheet" role="dialog" aria-label={s.name}><div className="grab" />
      <div className="scrollable">
        <div className="row"><Av n={s.name} /><div className="t"><b style={{ fontSize: 18 }}>{s.name}</b><span>{s.designation ?? 'Staff'} · {s.hub} hub</span></div></div>
        <div className="meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>{statusChip(s)}{s.early && <span className="chip c-bad">Early out</span>}</div>
        {month && <div className="ft" style={{ marginTop: 14, background: 'var(--ph-surface)', borderRadius: 16, padding: '12px 6px', gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
          <div><b>{month.on}</b><span>On time</span></div><div><b>{month.late}</b><span>Late</span></div><div><b>{month.early}</b><span>Early out</span></div></div>}
        {s.cat === 'od' && s.od && <div className="quote" style={{ marginTop: 12 }}><small>OD today</small>{s.od.subject} · {s.od.venue}</div>}
        {s.cat !== 'lv' && (!d ? <Spin /> : <div className="dayc" style={{ marginTop: 16 }}>{tile('in')}{tile('out')}</div>)}
        <p className="to" style={{ marginBottom: 0 }}><Icon n="eye" size={14} style={{ verticalAlign: -2 }} /> View only. Changes go through HR.</p>
      </div>
      <button className="btn ghost" style={{ marginTop: 6 }} onClick={onClose}>Close</button></div></>);
}

// ---------------- dispute alerts (view only) ----------------
function Alerts({ onBack, onOpen }: { onBack: () => void; onOpen: (f: Flag) => void }) {
  const [list, setList] = useState<Flag[] | null>(null);
  useEffect(() => { chair.alerts().then(setList).catch(() => setList([])); }, []);
  const st = (f: Flag) => f.status === 'violation' ? ['Violation', 'c-bad'] : f.status === 'valid' ? ['Cleared by HR', 'c-ok'] : f.status === 'reason_asked' ? ['Reason asked', 'c-warn'] : ['Open with HR', 'c-warn'];
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small="Last 30 days" big="Dispute alerts" onBack={onBack} />
      <div className="note-hr"><Icon n="eye" size={16} />HR decides. You see every signal.</div>
      {list && <div className="card"><div className="ft">
        <div><b>{list.length}</b><span>Raised</span></div><div><b>{list.filter((f) => f.status === 'valid').length}</b><span>Cleared</span></div>
        <div><b>{list.filter((f) => f.status === 'violation').length}</b><span>Violations</span></div><div><b>{list.filter((f) => f.status === 'open' || f.status === 'reason_asked').length}</b><span>Open</span></div></div></div>}
      <div className="sec">Latest</div>
      {!list ? <Spin /> : list.length === 0 ? <div className="empty"><b>No alerts</b>All clear for 30 days.</div> : list.map((f) => {
        const [lab, cls] = FLAG_LABEL[f.kind] ?? [f.kind, 'c-pend'], [sl, sc] = st(f);
        return (
          <button key={f.id} className="req" style={{ width: '100%', textAlign: 'left', display: 'block', marginBottom: 10 }} onClick={() => onOpen(f)}>
            <span className="hd"><Av n={f.who} /><span className="t"><b>{f.who}</b><span>{f.hub ?? 'No hub'} · {fmtShortDay(new Date(f.created_at))} · {fmtTime(f.created_at)}</span></span><span className={`chip ${cls}`}>{lab}</span></span>
            <span className="meta" style={{ display: 'flex' }}><span className={`chip ${sc}`}>{sl}</span>{f.punch?.quality_score != null && <span className="chip c-pend">Quality {f.punch.quality_score}</span>}</span>
          </button>);
      })}
    </div>
  );
}

function AlertView({ f, onBack }: { f: Flag; onBack: () => void }) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(f.punch?.place_name ?? null);
  useEffect(() => { hr.selfieUrl(f.punch?.selfie_key ?? null).then(setPhoto); if (f.punch && !f.punch.place_name) placeLabel(f.punch.lat, f.punch.lng).then(setPlace); }, [f]);
  const [lab] = FLAG_LABEL[f.kind] ?? [f.kind], pu = f.punch, q = pu?.quality_score ?? null;
  const decision = f.status === 'violation' ? ['Violation', 'c-bad'] : f.status === 'valid' ? ['Cleared', 'c-ok'] : f.status === 'reason_asked' ? ['Reason asked', 'c-warn'] : ['Open', 'c-warn'];
  const Sig = ({ l, v, c }: { l: string; v: string; c: string }) => <div className="sig"><span>{l}</span><span className={`chip ${c}`}>{v}</span></div>;
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Top small={`${f.who} · ${f.hub ?? ''}`} big={lab} onBack={onBack} />
      <div className="shot">{photo ? <img src={photo} alt={`${f.who} selfie`} /> : <div className="center" style={{ background: '#D9DCE3', color: 'var(--ph-ink3)', fontSize: 14 }}>No photo</div>}
        <div className="stamp">{f.who} · Check in<br />{pu ? `${fmtShortDay(new Date(pu.server_time))} · ${fmtTime(pu.server_time)} IST` : ''}<br />{place ?? ''}</div></div>
      {pu && <div className="card" style={{ marginTop: 12 }}>
        <div className="row"><span className="ri c-bad"><Icon n="pin" /></span><span className="t"><b>Probable location</b><span style={{ whiteSpace: 'normal' }}>{place ?? 'Finding place name…'}</span></span></div>
        <dl className="kv" style={{ marginTop: 12 }}>{pu.distance_m != null && <><dt>From {f.hub ?? 'target'} hub</dt><dd>{fmtDistance(pu.distance_m)}</dd></>}<dt>Coordinates</dt><dd>{pu.lat.toFixed(5)}, {pu.lng.toFixed(5)}</dd></dl>
        <div className="two" style={{ marginTop: 12 }}>
          <a className="btn light" style={{ height: 44, fontSize: 14, textDecoration: 'none' }} href={googleMapsUrl(pu.lat, pu.lng)} target="_blank" rel="noreferrer">Google Maps</a>
          <a className="btn light" style={{ height: 44, fontSize: 14, textDecoration: 'none' }} href={appleMapsUrl(pu.lat, pu.lng)} target="_blank" rel="noreferrer">Apple Maps</a></div></div>}
      {f.staff_reason && <div className="quote" style={{ marginTop: 12 }}><small>{f.who.split(' ')[0]} says</small>“{f.staff_reason}”</div>}
      {q !== null && <div className="card" style={{ marginTop: 12 }}><div className="qhd"><span>Live data quality</span><b>{q}<small>/100</small></b></div>
        <div className="bar"><i style={{ width: `${q}%`, background: q >= 70 ? 'var(--ok)' : 'var(--bad)' }} /></div></div>}
      <div className="sec">Signals</div>
      <div className="card"><Sig l="Rule" v={f.rule.split(' ')[0]} c="c-pend" />
        {pu?.accuracy_m != null && <Sig l="GPS accuracy" v={`${Math.round(pu.accuracy_m)} m`} c={pu.accuracy_m <= 50 ? 'c-ok' : 'c-warn'} />}
        {pu?.face_similarity != null && <Sig l="Face match" v={`${Math.round(pu.face_similarity)}%`} c={pu.face_similarity >= 80 ? 'c-ok' : 'c-bad'} />}</div>
      <div className="card row" style={{ marginTop: 16 }}><span className={`ri ${decision[1]}`}><Icon n="flag" /></span><span className="t"><b>HR decision</b><span>{decision[0]}</span></span></div>
      <p className="to"><Icon n="eye" size={14} style={{ verticalAlign: -2 }} /> View only</p>
    </div>
  );
}
