import { lazy, Suspense, useEffect, useState } from 'react';
import { hr, type LiveRow, type PresenceRow } from '../../lib/hr';
import { fmtTime } from '../../lib/time';
import { Icon } from '../../ui/Icon';
import { WorkHours } from '../../ui/WorkHours';

const MapView = lazy(() => import('../../ui/MapView'));
const COLOR: Record<string, string> = { inside: '#1FAA6B', outside: '#E5303F', od: '#2F62D9', no_signal: '#8A8A93', not_started: '#C9CCD3', checked_out: '#0E0E11', no_app: '#C9CCD3' };
const LABEL: Record<string, string> = { inside: 'Inside', outside: 'Outside', od: 'On OD', no_signal: 'No location', not_started: 'Not started', checked_out: 'Checked out', no_app: 'No app' };
const CHIP: Record<string, string> = { inside: 'c-ok', outside: 'c-bad', od: 'c-od', no_signal: 'c-pend', not_started: 'c-warn', checked_out: 'c-mute', no_app: 'c-mute' };
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/** HR / Chairman / Tech: where every checked-in staff member is now (store app, 10–6). Refreshes every minute. */
export function LiveMap({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<LiveRow[] | null>(null);
  const [f, setF] = useState<string>('all');
  const [at, setAt] = useState(new Date());
  useEffect(() => {
    const load = () => hr.liveLocations().then((r) => { setRows(r); setAt(new Date()); }).catch(() => setRows([]));
    load(); const t = setInterval(load, 60000); return () => clearInterval(t);
  }, []);
  const count = (s: string) => (rows ?? []).filter((r) => r.state === s).length;
  const shown = (rows ?? []).filter((r) => f === 'all' || r.state === f);
  const pts = shown.filter((r) => r.lat != null && r.lng != null).map((r) => ({ lat: r.lat!, lng: r.lng!, color: COLOR[r.state], label: `${r.full_name} · ${LABEL[r.state]} · ${r.at ? fmtTime(r.at) : ''}` }));
  return (
    <div className="scr">
      <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>Live tracking</small><b>Live map</b></div><span className="sp" /></div>
      <div className="pillrow" role="group" aria-label="Filter">
        {['all', 'outside', 'no_signal', 'not_started', 'no_app', 'inside', 'od'].map((k) => <button key={k} className={`pill ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{k === 'all' ? `All ${rows?.length ?? ''}` : `${LABEL[k]} ${count(k)}`}</button>)}
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 8 }}>
        <Suspense fallback={<div className="center" style={{ height: 320 }}><span className="spin dark" /></div>}><MapView points={pts} height={320} /></Suspense>
      </div>
      <p className="to" style={{ textAlign: 'left', margin: '8px 2px' }}>Updated {fmtTime(at.toISOString())} · every minute · store app only</p>
      {!rows ? <div className="center" style={{ height: 80 }}><span className="spin dark" /></div> : shown.length === 0 ? <div className="empty"><b>Nobody here</b>Staff appear after they check in.</div> :
        <div className="card" style={{ padding: '4px 14px' }}>{shown.map((r) => (
          <div key={r.user_id ?? `${r.full_name}-${r.hub}`} className="lrow"><span className="t"><b>{r.full_name}</b><span>{r.hub ?? 'No hub'}{r.at ? ` · last ${fmtTime(r.at)}` : ''}</span></span><span className="v"><span className={`chip ${CHIP[r.state]}`}>{LABEL[r.state]}</span></span></div>))}</div>}
    </div>
  );
}

/** HR / Chairman / Tech: who went out today (or another day) and for how long, most time out first. */
export function OutToday({ onBack }: { onBack: () => void }) {
  const [day, setDay] = useState(istToday());
  const [rows, setRows] = useState<PresenceRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setRows(null); hr.presenceBoard(day).then(setRows).catch(() => setRows([])); }, [day]);
  const out = (rows ?? []).filter((r) => r.outside_min > 0), quiet = (rows ?? []).filter((r) => !r.tracked || r.no_signal_min >= 20);
  return (
    <div className="scr">
      <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>Live tracking</small><b>Out of office</b></div><span className="sp" /></div>
      <input className="inp" type="date" value={day} max={istToday()} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day" />
      {rows && <div className="gcard gc4" style={{ marginTop: 12 }}>
        <div><small>Tracked</small><b>{rows.filter((r) => r.tracked).length}</b><em>of {rows.length} in</em></div>
        <div><small>Went out</small><b>{out.length}</b><em>people</em></div>
        <div><small>Time out</small><b>{mins(out.reduce((a, r) => a + r.outside_min, 0))}</b><em>total</em></div>
        <div><small>No location</small><b>{quiet.length}</b><em>20+ min</em></div>
      </div>}
      {!rows ? <div className="center" style={{ height: 120 }}><span className="spin dark" /></div> : rows.length === 0 ? <div className="empty"><b>No one checked in</b>Pick another day.</div> :
        <div className="card" style={{ padding: '4px 14px', marginTop: 12 }}>{rows.map((r, i) => (<div key={r.user_id ?? `n${i}`}>
          <button className="lrow" style={{ width: '100%', textAlign: 'left' }} onClick={() => r.user_id && setOpen(open === r.user_id ? null : r.user_id)}>
            <span className="t"><b>{r.full_name}</b><span>{r.hub ?? 'No hub'}{r.trips ? ` · ${r.trips} trip${r.trips > 1 ? 's' : ''}, longest ${mins(r.longest_trip)}` : ''}</span></span>
            <span className="v" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              {!r.user_id ? <span className="chip c-mute">No app</span> : !r.tracked ? <span className="chip c-warn">Not tracked</span> : r.outside_min > 0 ? <span className="chip c-bad">Out {mins(r.outside_min)}</span> : <span className="chip c-ok">Inside</span>}
              {r.tracked && r.no_signal_min >= 20 && <span className="chip sm c-pend">No location {mins(r.no_signal_min)}</span>}
            </span></button>
          {r.user_id && open === r.user_id && day === istToday() && <WorkHours userId={r.user_id} />}
        </div>))}</div>}
    </div>
  );
}
