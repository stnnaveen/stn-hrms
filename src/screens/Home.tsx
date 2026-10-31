import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, type Notif } from '../lib/api';
import { fmtShortDay, fmtTime, greeting, hoursBetween, istMinutesNow, splitTime } from '../lib/time';
import { Icon } from '../ui/Icon';
import { AccountSheet } from '../ui/AccountSheet';
import { RefreshButton } from '../ui/RefreshButton';

const BAND_CHIP = {
  ok: <span className="chip c-ok"><i />On time</span>,
  warn: <span className="chip c-warn"><i />Slightly late</span>,
  bad: <span className="chip c-bad"><i />Late</span>
};
const STATUS_CHIP: Record<string, string> = { approved: 'c-ok', pending: 'c-pend', returned: 'c-bad', cancelled: 'c-pend' };

export function Home() {
  const { today, reload, go, setCamMode, setOdPrefill } = useApp();
  const [fab, setFab] = useState(false);
  const [sheet, setSheet] = useState<null | 'early' | 'early1h'>(null);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [account, setAccount] = useState(false);
  const [now, setNow] = useState(istMinutesNow());
  useEffect(() => { reload(); api.notifications().then(setNotifs); const t = setInterval(() => setNow(istMinutesNow()), 30000); return () => clearInterval(t); }, [reload]);

  if (!today) return <div className="center"><span className="spin dark" /></div>;
  const p = today.profile, d = today.today;
  const first = p.full_name.split(' ')[0];
  const checkedIn = !!d?.in_time, checkedOut = !!d?.out_time;
  const due = checkedIn && !checkedOut && now >= 1080;
  const [inT, inAp] = splitTime(d?.in_time);
  const [outT, outAp] = splitTime(d?.out_time);
  const unread = notifs.some((n) => !n.read_at);
  // approved OD today: the venue check-in opens 30 min before the start (same window the server uses)
  const od = today.od_today ?? null;
  const odFrom = od ? new Date(od.starts_at).getTime() - 30 * 60000 : 0;
  const odOpen = !!od && Date.now() >= odFrom && Date.now() <= new Date(od.ends_at).getTime();

  let topChip = <span className="chip c-mute"><i />Not checked in</span>;
  if (checkedIn && !checkedOut && d?.band) topChip = BAND_CHIP[d.band];
  if (checkedOut) topChip = <span className="chip c-mute"><i />Day done</span>;

  const startCheckout = () => {
    const left = 1080 - now;
    if (left > 60) setSheet('early1h'); else if (left > 0) setSheet('early'); else { setCamMode('out'); go('camera'); }
  };

  return (
    <>
      <div className="scr fade">
        <div className="hdr">
          <button className="av" onClick={() => setAccount(true)} aria-label={`${p.full_name}, account and log out`}>{p.full_name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</button>
          <div className="r">
            <RefreshButton />
            <button className="rbtn" onClick={() => go('notifs')} aria-label="Notifications"><Icon n="bell" />{unread && <span className="badge" />}</button>
          </div>
        </div>
        {due && (
          <div className="banner"><span className="pulse" /><div className="t"><b>Time to check out</b><span>Office closed at 6:00 PM</span></div>
            <button className="sbtn" onClick={() => { setCamMode('out'); go('camera'); }}>Check out</button></div>
        )}
        <div className="dark">
          <div className="top"><div><div className="hi">{greeting()}, {first}</div><div className="day">Today, {fmtShortDay()}</div></div>{topChip}</div>
          <div className="gcard">
            <div><small>Check in</small><b>{inT}</b><em>{checkedIn ? inAp : 'By 10:00'}</em></div>
            <div><small>Check out</small><b>{outT}</b><em>{checkedOut ? outAp : 'From 6:00'}</em></div>
            <div><small>Hours</small><b>{hoursBetween(d?.in_time, d?.out_time)}</b><em>{p.hub ? `${p.hub} hub` : 'No hub'}</em></div>
          </div>
        </div>
        {od && (<>
          <div className="sec">OD today</div>
          <div className="card">
            <div className="row"><div className="ri c-od"><Icon n="brief" /></div>
              <div className="t"><b>{od.subject}</b><span>{od.venue_name} · {fmtTime(od.starts_at)} – {fmtTime(od.ends_at)}</span></div>
              {od.visited_at ? <span className="chip c-ok">Done {fmtTime(od.visited_at)}</span> : <span className="chip c-od">Approved</span>}</div>
            {!od.visited_at && (odOpen
              ? (checkedIn ? <button className="btn dark" style={{ marginTop: 12 }} onClick={() => { setCamMode('visit'); go('camera'); }}><Icon n="pin" />Check in at venue</button>
                : <p className="to" style={{ margin: '12px 0 0' }}>Check in from the venue today.</p>)
              : <p className="to" style={{ margin: '12px 0 0' }}>{Date.now() < odFrom ? `Check in at the venue from ${fmtTime(new Date(odFrom).toISOString())}.` : 'OD time is over.'}</p>)}
            {od.venue_url && <a className="btn light" style={{ marginTop: 8, height: 44, fontSize: 14, textDecoration: 'none' }} href={od.venue_url} target="_blank" rel="noreferrer">Open in Maps</a>}
          </div>
        </>)}
        <div className="sec">This month</div>
        <div className="tiles">
          <div className="tile"><b>{today.month.on_time}</b><span><i style={{ background: 'var(--ok)' }} />On time</span></div>
          <div className="tile"><b>{today.month.late}</b><span><i style={{ background: 'var(--warn)' }} />Late</span></div>
          <div className="tile"><b>{today.month.early}</b><span><i style={{ background: 'var(--bad)' }} />Early out</span></div>
        </div>
        <div className="sec">Requests</div>
        <div className="card">
          {today.requests.length === 0 && <span style={{ color: 'var(--ph-ink3)', fontSize: 14 }}>No requests yet.</span>}
          {today.requests.map((r) => (
            <div className="row" key={r.id}>
              <div className={`ri ${r.type === 'od' ? 'c-od' : 'c-lv'}`}><Icon n={r.type === 'od' ? 'brief' : 'leaf'} /></div>
              <div className="t"><b>{r.title}</b><span>{fmtShortDay(new Date(r.starts))}</span></div>
              <span className={`chip ${STATUS_CHIP[r.status] ?? 'c-pend'}`}>{r.status[0].toUpperCase() + r.status.slice(1)}</span>
            </div>
          ))}
        </div>
      </div>

      {fab && (<>
        <div className="scrim" onClick={() => setFab(false)} />
        <div className="fmenu">
          <button onClick={() => { setFab(false); go('leave'); }}><span className="ri c-lv"><Icon n="leaf" /></span>Leave</button>
          <button onClick={() => { setFab(false); setOdPrefill(null); go('od'); }}><span className="ri c-od"><Icon n="brief" /></span>OD</button>
        </div>
      </>)}

      <div className="dock">
        {checkedOut
          ? <div className="ci done"><button className="orb" disabled aria-label="Done for today"><Icon n="check" /></button><span className="cap">Done for today</span></div>
          : checkedIn
            ? <div className="ci"><button className="orb" onClick={startCheckout} aria-label="Check out"><Icon n="out" /></button><span className="cap">Check out</span></div>
            : <div className="ci"><button className="orb" onClick={() => { setCamMode('in'); go('camera'); }} aria-label="Check in"><Icon n="scan" /></button><span className="cap">Check in</span></div>}
      </div>
      <button className={`fab ${fab ? 'open' : ''}`} onClick={() => setFab(!fab)} aria-label={fab ? 'Close' : 'New request'} aria-expanded={fab}><Icon n="plus" /></button>

      {account && <AccountSheet name={p.full_name} sub={`${p.employee_code ? p.employee_code + ' · ' : ''}${p.hub ?? 'No'} hub`} onClose={() => setAccount(false)} />}
      {sheet && <div className="scrim" onClick={() => setSheet(null)} />}
      {sheet === 'early' && (
        <div className="sheet" role="dialog" aria-label="Leaving early"><div className="grab" />
          <h3>Leaving early?</h3><p>{1080 - now} min before 6:00 PM.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 22 }}>
            <button className="btn dark" onClick={() => { setSheet(null); setCamMode('out'); go('camera'); }}>Check out</button>
            <button className="btn ghost" onClick={() => setSheet(null)}>Stay</button>
          </div></div>
      )}
      {sheet === 'early1h' && (
        <div className="sheet" role="dialog" aria-label="Leaving early"><div className="grab" />
          <h3>Leaving early?</h3><p>{Math.floor((1080 - now) / 60)}h {(1080 - now) % 60}m before 6:00 PM.</p>
          <div className="opts">
            <button className="opt" onClick={() => { setSheet(null); setCamMode('out'); go('camera'); }}><div className="ri c-warn"><Icon n="leaf" /></div><div><b>Early leave</b><span>Logged for HR</span></div><Icon n="chevR" className="c" /></button>
            <button className="opt" onClick={() => { setSheet(null); setOdPrefill({ urgent: true }); go('od'); }}><div className="ri c-od"><Icon n="brief" /></div><div><b>Urgent work</b><span>Raise an OD</span></div><Icon n="chevR" className="c" /></button>
          </div>
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setSheet(null)}>Cancel</button></div>
      )}
    </>
  );
}
