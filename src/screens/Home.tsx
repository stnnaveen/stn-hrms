import { DiwaliBanner, SkyCrackers, crackers, diwaliOn } from '../ui/Festive';
import { isStoreApp } from '../device/presence';
import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, type Notif, type MyFinger } from '../lib/api';
import { fmtShortDay, fmtTime, greeting, hoursBetween, istMinutesNow, splitTime, outChip } from '../lib/time';
import { Icon } from '../ui/Icon';
import { MyCalendar } from '../ui/MyCalendar';
import { ToApprove } from '../ui/ToApprove';
import { AccountSheet } from '../ui/AccountSheet';
import { RefreshButton } from '../ui/RefreshButton';
import { HelpButton } from '../ui/Help';

const BAND_CHIP = {
  ok: <span className="chip c-ok"><i />On time</span>,
  warn: <span className="chip c-warn"><i />Slightly late</span>,
  bad: <span className="chip c-bad"><i />Late</span>
};
const STATUS_CHIP: Record<string, string> = { approved: 'c-ok', pending: 'c-pend', returned: 'c-bad', cancelled: 'c-pend' };

export function Home() {
  const { today, reload, go, setCamMode, setOdPrefill, setLeaveOd, toast } = useApp();
  const festive = diwaliOn();
  // store app: ask once for work-hours location (check-in → check-out, office hours). Never in the browser app.
  const [needPresence, setNeedPresence] = useState(false);
  useEffect(() => { if (isStoreApp()) api.presenceConsent().then((ok) => setNeedPresence(!ok)).catch(() => undefined); }, []);
  const [finger, setFinger] = useState<MyFinger | null>(null);
  useEffect(() => { api.myFingerprint().then(setFinger).catch(() => undefined); }, [today]);
  const [fab, setFab] = useState(false);
  const [sheet, setSheet] = useState<null | 'early' | 'early1h' | 'out'>(null);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [account, setAccount] = useState(false);
  const [now, setNow] = useState(istMinutesNow());
  useEffect(() => { reload(); api.notifications().then(setNotifs); const t = setInterval(() => setNow(istMinutesNow()), 30000); return () => clearInterval(t); }, [reload]);

  if (!today) return <div className="center"><span className="spin dark" /></div>;
  const p = today.profile, d = today.today;
  const first = p.full_name.split(' ')[0];
  // the hub's check-in method (Tech admin): bio = fingerprint only, selfie only for OD venues; both = either one
  const method = today.checkin ?? 'both';
  // the day as it counts (server merges selfie and fingerprint); falls back to the selfie day
  const m = today.day ?? (d ? { in_time: d.in_time, out_time: d.out_time, band: d.band, early_out: d.early_out, in_src: 'app' as const, out_src: d.out_time ? 'app' as const : null } : null);
  const appIn = !!d?.in_time, appOut = !!d?.out_time;
  const checkedIn = !!m?.in_time, checkedOut = appOut || (!!m?.out_time && m.out_src === 'bio');
  const unread = notifs.some((n) => !n.read_at);
  const month = today.month;   // merged on the server
  // approved OD today: the venue check-in opens 30 min before the start (same window the server uses)
  const od = today.od_today ?? null;
  const odFrom = od ? new Date(od.starts_at).getTime() - 30 * 60000 : 0;
  const odOpen = !!od && Date.now() >= odFrom && Date.now() <= new Date(od.ends_at).getTime();
  const odsLeft = (today.ods_today ?? []).filter((o) => new Date(o.ends_at).getTime() > Date.now());
  // what the selfie button does: fingerprint-only hubs use it only at an OD venue (or to close an OD day)
  const action: 'in' | 'out' | 'done' | 'finger' =
    checkedOut ? 'done'
      : method === 'bio' ? (appIn ? (d?.status === 'od' ? 'out' : 'finger') : (odOpen && !checkedIn ? 'in' : m?.out_time ? 'done' : 'finger'))
        : checkedIn ? 'out' : 'in';
  const due = action === 'out' && now >= 1080;
  const [inT, inAp] = splitTime(m?.in_time);
  const [outT, outAp] = splitTime(m?.out_time);
  const avail = today.chairman_available ?? [];
  const resetDay = async () => { try { await api.resetTestDay(); await reload(); toast('Test day cleared'); } catch { toast('Could not reset'); } };

  let topChip = <span className="chip c-mute"><i />Not checked in</span>;
  if (checkedIn && !checkedOut && m?.band) topChip = BAND_CHIP[m.band];
  if (checkedOut) topChip = <span className="chip c-mute"><i />Day done</span>;

  const startCheckout = () => {
    const left = 1080 - now;
    setLeaveOd(null);
    // before 6 PM: going to an OD today is not an early leave
    if (left > 0 && odsLeft.length) setSheet('out');
    else if (left > 60) setSheet('early1h'); else if (left > 0) setSheet('early'); else { setCamMode('out'); go('camera'); }
  };

  return (
    <>
      <div className="scr fade">
        <div className="hdr">
          <button className="av" onClick={() => setAccount(true)} aria-label={`${p.full_name}, account and log out`}>{p.full_name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</button>
          <div className="r">
            <HelpButton />
            <RefreshButton />
            <button className="rbtn" onClick={() => go('notifs')} aria-label="Notifications"><Icon n="bell" />{unread && <span className="badge" />}</button>
          </div>
        </div>
        {due && (
          <div className="banner"><span className="pulse" /><div className="t"><b>Time to check out</b><span>Office closed at 6:00 PM</span></div>
            <button className="sbtn" onClick={() => { setCamMode('out'); go('camera'); }}>Check out</button></div>
        )}
        {needPresence && (
          <div className="banner"><span className="ri c-od" style={{ width: 36, height: 36 }}><Icon n="pin" size={18} /></span><div className="t"><b>Work-hours location</b><span>Check-in to check-out, office hours only.</span></div>
            <button className="sbtn" onClick={async () => { try { await api.givePresenceConsent(); setNeedPresence(false); toast('Location on for work hours'); void reload(); } catch { toast('Could not save. Try again.'); } }}>Agree</button></div>
        )}
        <DiwaliBanner name={first} />
        <div className="dark"><SkyCrackers />
          <div className="top"><div><div className="hi">{greeting()}, {first}</div><div className="day">Today, {fmtShortDay()}</div></div>{topChip}</div>
          <div className="gcard">
            <div><small>Check in</small><b>{inT}</b><em>{checkedIn ? inAp : 'By 10:00'}</em></div>
            <div><small>Check out</small><b>{outT}</b><em>{checkedOut ? outAp : 'From 6:00'}</em></div>
            <div><small>Hours</small><b>{hoursBetween(m?.in_time, m?.out_time)}</b><em>{p.hub ? `${p.hub} hub` : 'No hub'}</em></div>
          </div>
        </div>
        {today.test_mode && (
          <div className="card row" style={{ marginTop: 12, background: '#FFF4E0' }}><span className="ri c-warn"><Icon n="alert" /></span>
            <span className="t"><b>Test account</b><span>Each check-in starts the day fresh.</span></span>
            <button className="chip c-warn" onClick={resetDay}>Reset today</button></div>)}
        {avail.length > 0 && (<>
          <div className="sec">Chairman available</div>
          <div className="card">{avail.map((a, i) => (
            <div className="row" key={i}><div className="ri c-ok"><Icon n="users" /></div>
              <div className="t"><b>{fmtTime(a.starts_at)} – {fmtTime(a.ends_at)}{a.place ? ` · ${a.place}` : ''}</b><span>{a.note ?? 'Open for a quick word'}</span></div></div>))}</div>
        </>)}
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
        {finger?.today && (<>
          <div className="sec">Fingerprint today</div>
          <div className="card"><div className="row"><div className="ri c-ok"><Icon n="scan" /></div>
            <div className="t"><b>eSSL Biometric device</b></div>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <span className={`chip ${finger.today.band === 'ok' ? 'c-ok' : finger.today.band === 'warn' ? 'c-warn' : 'c-bad'}`}>In {fmtTime(finger.today.in_at)}</span>
              {finger.today.out_at ? <span className={`chip ${outChip(finger.today.out_at)}`}>Out {fmtTime(finger.today.out_at)}</span> : <span className="chip c-pend">No out yet</span>}
            </span></div></div>
        </>)}
        <div className="sec">This month</div>
        <div className="tiles">
          <div className="tile"><b>{month.on_time}</b><span><i style={{ background: 'var(--ok)' }} />On time</span></div>
          <div className="tile"><b>{month.late}</b><span><i style={{ background: 'var(--warn)' }} />Late</span></div>
          <div className="tile"><b>{month.early}</b><span><i style={{ background: 'var(--bad)' }} />Early out</span></div>
        </div>
        <ToApprove />
        <div className="sec">My calendar</div>
        <MyCalendar key={today.today?.in_time ?? 'x'} />
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
        {action === 'done'
          ? <div className="ci done"><button className="orb" disabled aria-label="Done for today"><Icon n="check" /></button><span className="cap">Done for today</span></div>
          : action === 'finger'
            ? <div className="ci done"><button className="orb" disabled aria-label="Use the fingerprint device"><Icon n="scan" /></button><span className="cap">{checkedIn ? 'Fingerprint out' : 'Fingerprint in'}</span></div>
          : action === 'out'
            ? <div className={`ci ${festive ? 'dw' : ''}`}><button className="orb" onClick={(e) => { crackers(e.currentTarget); startCheckout(); }} aria-label="Check out"><Icon n="out" /></button><span className="cap">Check out</span></div>
            : <div className={`ci ${festive ? 'dw' : ''}`}><button className="orb" onClick={(e) => { crackers(e.currentTarget); setCamMode('in'); go('camera'); }} aria-label="Check in"><Icon n="scan" /></button><span className="cap">{method === 'bio' ? 'Venue check-in' : 'Check in'}</span></div>}
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
      {sheet === 'out' && (
        <div className="sheet" role="dialog" aria-label="Check out"><div className="grab" />
          <h3>Heading out?</h3><p>{Math.floor((1080 - now) / 60)}h {(1080 - now) % 60}m before 6:00 PM.</p>
          <div className="opts">
            {odsLeft.map((o) => (
              <button key={o.id} className="opt" onClick={() => { setSheet(null); setLeaveOd(o.id); setCamMode('out'); go('camera'); }}>
                <div className="ri c-od"><Icon n="brief" /></div><div><b>Going to OD</b><span>{o.subject} · {fmtTime(o.starts_at)}{o.status === 'pending' ? ' · awaiting approval' : ''}</span></div><Icon n="chevR" className="c" /></button>))}
            <button className="opt" onClick={() => { setSheet(null); setCamMode('out'); go('camera'); }}><div className="ri c-warn"><Icon n="leaf" /></div><div><b>Early leave</b><span>Logged for HR</span></div><Icon n="chevR" className="c" /></button>
            <button className="opt" onClick={() => { setSheet(null); setOdPrefill({ urgent: true }); go('od'); }}><div className="ri c-pend"><Icon n="plus" /></div><div><b>Different work</b><span>Raise an OD first</span></div><Icon n="chevR" className="c" /></button>
          </div>
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setSheet(null)}>Cancel</button></div>
      )}
      {sheet === 'early1h' && (
        <div className="sheet" role="dialog" aria-label="Leaving early"><div className="grab" />
          <h3>Leaving early?</h3><p>{Math.floor((1080 - now) / 60)}h {(1080 - now) % 60}m before 6:00 PM.</p>
          <div className="opts">
            <button className="opt" onClick={() => { setSheet(null); setCamMode('out'); go('camera'); }}><div className="ri c-warn"><Icon n="leaf" /></div><div><b>Early leave</b><span>Logged for HR</span></div><Icon n="chevR" className="c" /></button>
            <button className="opt" onClick={() => { setSheet(null); setOdPrefill({ urgent: true }); go('od'); }}><div className="ri c-od"><Icon n="brief" /></div><div><b>Urgent work</b><span>Raise an OD, then check out</span></div><Icon n="chevR" className="c" /></button>
          </div>
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setSheet(null)}>Cancel</button></div>
      )}
    </>
  );
}
