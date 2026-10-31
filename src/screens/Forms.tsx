import { useEffect, useRef, useState } from 'react';
import { useApp } from '../App';
import { api, ApiError, errorText, type Venue } from '../lib/api';
import { readClipboard } from '../device';
import { Icon } from '../ui/Icon';

const MAPS_RE = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z.]+|maps\.apple\.com|maps\.apple)(\/|$|\?)/i;
const todayISO = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const istToUtc = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`).toISOString();

/** Pull coordinates out of a Google Maps link or "lat, lng". Short links (maps.app.goo.gl) cannot be read here; HR pins those. */
export function parseVenue(v: string): { lat: number; lng: number } | null {
  const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|ll|query)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/];
  for (const p of pats) { const m = v.match(p); if (m) return { lat: Number(m[1]), lng: Number(m[2]) }; }
  return null;
}

function Title({ small, big, onBack }: { small: string; big: string; onBack: () => void }) {
  return <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>{small}</small><b>{big}</b></div><span className="sp" /></div>;
}

export function ODForm() {
  const { back, toast, odPrefill, reload } = useApp();
  const urgent = !!odPrefill?.urgent;
  const [f, setF] = useState({ subject: '', venue: '', shape: urgent ? 'hours' : 'hours', date: todayISO(), to: todayISO(), from: urgent ? nowHHMM() : '11:00', until: '18:00', note: '' });
  const [errs, setErrs] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  // venue = a Google or Apple Maps link, read on the server into a pin + place name (no typed places)
  const [venue, setVenue] = useState<Venue | null>(null);
  const [vState, setVState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [vErr, setVErr] = useState('');
  const [vName, setVName] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    const text = f.venue.trim();
    setVenue(null); setVErr('');
    if (!text) { setVState('idle'); return; }
    if (!MAPS_RE.test(text.match(/https?:\/\/\S+/)?.[0] ?? '')) { setVState('error'); setVErr(errorText('not_maps_link')); return; }
    setVState('checking');
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try { const v = await api.resolveVenue(text); if (my !== seq.current) return; setVenue(v); setVName(v.name ?? v.place?.split(',')[0] ?? ''); setVState('ok'); }
      catch (e) { if (my !== seq.current) return; setVState('error'); setVErr(e instanceof ApiError && e.code !== 'network' ? errorText(e.code) : 'Couldn’t check the link. Try again.'); }
    }, 450);
    return () => clearTimeout(t);
  }, [f.venue]);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const startsAt = f.shape === 'hours' ? istToUtc(f.date, f.from) : istToUtc(f.date, '10:00');
  const endsAt = f.shape === 'hours' ? istToUtc(f.date, f.until) : istToUtc(f.shape === 'days' ? f.to : f.date, '18:00');
  const hoursAhead = (new Date(startsAt).getTime() - Date.now()) / 3.6e6;

  const submit = async () => {
    const e: Record<string, boolean> = {};
    if (f.subject.trim().length < 2) e.subject = true;
    if (!venue) e.venue = true;
    if (venue && !vName.trim()) e.vname = true;
    if (new Date(endsAt) <= new Date(startsAt)) e.time = true;
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.createOD({ subject: f.subject.trim(), note: f.note.trim() || undefined, venue_name: vName.trim(), venue_lat: venue!.lat, venue_lng: venue!.lng,
        venue_url: venue!.url, venue_place: venue!.place, starts_at: startsAt, ends_at: endsAt });
      await reload(); toast('OD sent for approval'); back();
    } catch (e) { toast(e instanceof ApiError ? errorText(e.code) : 'Could not send. Try again.'); } finally { setBusy(false); }
  };

  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Title small={urgent ? 'Urgent work' : 'New request'} big="OD" onBack={back} />
      <label className="lab" htmlFor="f-subject">Subject</label>
      <input className="inp" id="f-subject" placeholder="Meeting at TIDCO" value={f.subject} onChange={(e) => set('subject', e.target.value)} />
      {errs.subject && <div className="err">Add a subject.</div>}
      <label className="lab" htmlFor="f-venue">Venue map link</label>
      <div className="inrow">
        <input className="inp" id="f-venue" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="Google Maps or Apple Maps link" value={f.venue} onChange={(e) => set('venue', e.target.value)} />
        <button className="btn light" type="button" onClick={async () => { const t = await readClipboard(); if (t) set('venue', t); }}>Paste</button>
      </div>
      {vState === 'idle' && <div className="hintl">In Maps, open the place → Share → Copy link.</div>}
      {vState === 'checking' && <div className="hintl"><span className="spin dark" style={{ width: 12, height: 12, verticalAlign: -1, marginRight: 6 }} />Finding the place…</div>}
      {vState === 'error' && <div className="err">{vErr}</div>}
      {venue && <div className="venue"><span className="ri c-od"><Icon n="pin" /></span><span className="t"><b>{venue.name ?? 'Pinned place'}</b><span>{venue.place ?? `${venue.lat.toFixed(5)}, ${venue.lng.toFixed(5)}`}</span></span><a href={venue.url} target="_blank" rel="noreferrer">Open</a></div>}
      {venue && <><label className="lab" htmlFor="f-vname">Venue name</label><input className="inp" id="f-vname" value={vName} onChange={(e) => setVName(e.target.value)} placeholder="TIDCO office" />{errs.vname && <div className="err">Add the venue name.</div>}</>}
      {errs.venue && !venue && vState !== 'error' && vState !== 'checking' && <div className="err">Paste the venue’s map link.</div>}
      <label className="lab">Duration</label>
      <div className="seg" role="group" aria-label="Duration">
        {[['hours', 'Hours'], ['day', 'Full day'], ['days', 'Days']].map(([k, l]) => (
          <button key={k} className={f.shape === k ? 'on' : ''} onClick={() => set('shape', k)} aria-pressed={f.shape === k}>{l}</button>
        ))}
      </div>
      <label className="lab" htmlFor="f-date">{f.shape === 'days' ? 'From' : 'Date'}</label>
      <input className="inp" id="f-date" type="date" value={f.date} min={todayISO()} onChange={(e) => set('date', e.target.value)} />
      {f.shape === 'days' && (<><label className="lab" htmlFor="f-to">To</label>
        <input className="inp" id="f-to" type="date" value={f.to} min={f.date} onChange={(e) => set('to', e.target.value)} /></>)}
      {f.shape === 'hours' && (
        <div className="two">
          <div><label className="lab" htmlFor="f-from">From</label><input className="inp" id="f-from" type="time" value={f.from} onChange={(e) => set('from', e.target.value)} /></div>
          <div><label className="lab" htmlFor="f-until">Until</label><input className="inp" id="f-until" type="time" value={f.until} onChange={(e) => set('until', e.target.value)} /></div>
        </div>
      )}
      {errs.time && <div className="err">End must be after start.</div>}
      <label className="lab" htmlFor="f-note">Note</label>
      <textarea className="inp" id="f-note" placeholder="Optional" value={f.note} onChange={(e) => set('note', e.target.value)} />
      {hoursAhead < 12 && <div className="note"><Icon n="clock" size={16} />Under 12 hours’ notice. Sent as quick.</div>}
      <button className="btn dark" style={{ marginTop: 22 }} disabled={busy || vState === 'checking'} onClick={submit}>{busy ? 'Sending' : 'Send'}</button>
    </div>
  );
}

export function LeaveForm() {
  const { back, toast, reload } = useApp();
  const [f, setF] = useState({ type: 'casual', from: todayISO(), to: todayISO(), half: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const bad = f.to < f.from;
  const submit = async () => {
    if (bad) return;
    setBusy(true);
    try {
      await api.createLeave({ leave_type: f.type, starts_on: f.from, ends_on: f.to, half_day: (f.half || null) as 'first' | 'second' | null, reason: f.reason.trim() || undefined });
      await reload(); toast('Leave sent to HR'); back();
    } catch { toast('Could not send. Try again.'); } finally { setBusy(false); }
  };
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <Title small="New request" big="Leave" onBack={back} />
      <label className="lab">Type</label>
      <div className="seg" role="group" aria-label="Leave type">
        {[['casual', 'Casual'], ['sick', 'Sick'], ['earned', 'Earned']].map(([k, l]) => (
          <button key={k} className={f.type === k ? 'on' : ''} onClick={() => set('type', k)} aria-pressed={f.type === k}>{l}</button>
        ))}
      </div>
      <div className="two">
        <div><label className="lab" htmlFor="l-from">From</label><input className="inp" id="l-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></div>
        <div><label className="lab" htmlFor="l-to">To</label><input className="inp" id="l-to" type="date" value={f.to} min={f.from} onChange={(e) => set('to', e.target.value)} /></div>
      </div>
      {bad && <div className="err">End date is before start.</div>}
      {f.from === f.to && (<>
        <label className="lab">Half day</label>
        <div className="seg" role="group" aria-label="Half day">
          {[['', 'No'], ['first', 'First half'], ['second', 'Second half']].map(([k, l]) => (
            <button key={k || 'none'} className={f.half === k ? 'on' : ''} onClick={() => set('half', k)} aria-pressed={f.half === k}>{l}</button>
          ))}
        </div>
      </>)}
      <label className="lab" htmlFor="l-reason">Reason</label>
      <textarea className="inp" id="l-reason" placeholder="Optional" value={f.reason} onChange={(e) => set('reason', e.target.value)} />
      <p className="to">Long leave is added by HR.</p>
      <button className="btn dark" disabled={busy || bad} onClick={submit}>{busy ? 'Sending' : 'Send'}</button>
    </div>
  );
}

function nowHHMM() {
  const d = new Date(Date.now() + 330 * 60000);
  return d.toISOString().slice(11, 16);
}
