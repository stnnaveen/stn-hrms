import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, ApiError, type MyMonth } from '../lib/api';
import { hr } from '../lib/hr';
import { fmtTime, outChip } from '../lib/time';
import { Icon } from './Icon';
import { RequestSheet } from './RequestSheet';

// One calendar for everyone (staff, HR, Chairman): the same server month (person_month), the same colours,
// the same legend. Holidays and office leave fill the day; check-in stays open on them.
const DOT: Record<string, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', od: 'var(--od)', leave: 'var(--lv)', marked: '#7A1F1F', none: '#C9CCD3' };
const LEGEND: [string, string][] = [['ok', 'On time'], ['warn', 'Slightly late'], ['bad', 'Late'], ['od', 'OD'], ['leave', 'Leave'], ['marked', 'Absent (HR)'], ['none', 'No check-in']];
const CHIP: Record<string, string> = { ok: 'c-ok', warn: 'c-warn', bad: 'c-bad' };
const Q: Record<string, [string, string]> = { pending: ['Query · waiting for HR', 'c-warn'], approved: ['Query · corrected', 'c-ok'], returned: ['Query · kept', 'c-bad'] };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const istKey = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
const istNow = () => new Date(Date.now() + 330 * 60000);

/** Staff: own calendar (can question a day HR marked). */
export function MyCalendar() { return <MonthCal who="me" />; }
/** HR / Chairman: the same calendar for one person. */
export function PersonCalendar({ email }: { email: string }) { return <MonthCal who={email} />; }

function MonthCal({ who }: { who: string }) {
  const { toast } = useApp();
  const me = who === 'me';
  const todayKey = istNow().toISOString().slice(0, 10);
  const [ym, setYm] = useState(todayKey.slice(0, 7));
  const [m, setM] = useState<MyMonth | null>(null);
  const [sel, setSel] = useState<string>(todayKey);
  const [tick, setTick] = useState(0);
  const [ask, setAsk] = useState<string | null>(null);   // query text being written
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // query id open in the timeline
  useEffect(() => {
    setM(null);
    (me ? api.myMonth(`${ym}-01`) : hr.personMonth(who, `${ym}-01`)).then(setM).catch(() => setM({ month: ym, days: [], od: [], leave: [] }));
  }, [ym, who, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const [y, mo] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(), len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const key = (n: number) => `${ym}-${String(n).padStart(2, '0')}`;
  const shift = (d: number) => { const t = new Date(Date.UTC(y, mo - 1 + d, 1)); setYm(t.toISOString().slice(0, 7)); setSel(''); setAsk(null); };
  const base = istNow();
  const lastYm = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 12, 1)).toISOString().slice(0, 7);
  const firstYm = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - 12, 1)).toISOString().slice(0, 7);

  const dayOf = (k: string) => m?.days.find((x) => x.day === k);
  const odsOf = (k: string) => (m?.od ?? []).filter((o) => istKey(o.starts_at) <= k && istKey(o.ends_at) >= k);
  const lvOf = (k: string) => (m?.leave ?? []).find((l) => l.from <= k && l.to >= k && l.status === 'approved') ?? (m?.leave ?? []).find((l) => l.from <= k && l.to >= k);
  const holOf = (k: string) => (m?.holidays ?? []).find((h) => h.day === k);
  const absOf = (k: string) => (m?.absent ?? []).includes(k);
  const qOf = (k: string) => [...(m?.queries ?? [])].reverse().find((q) => q.day === k);
  // one rule for the dot, everywhere: leave > absent (HR) > timing > OD > no check-in (past working day)
  const state = (k: string): string | null => {
    const lv = lvOf(k), d = dayOf(k), wd = new Date(`${k}T12:00:00Z`).getUTCDay();
    if (lv && lv.status === 'approved') return 'leave';
    if (absOf(k)) return 'marked';
    if (d?.band) return d.band;
    if (odsOf(k).some((o) => o.status === 'approved')) return 'od';
    if (k < todayKey && wd !== 0 && wd !== 6 && !holOf(k)) return 'none';
    return null;
  };
  const counts: Record<string, number> = {};
  if (m) for (let n = 1; n <= len; n++) { const s = state(key(n)); if (s) counts[s] = (counts[s] ?? 0) + 1; }
  const hols = m?.holidays ?? [];

  const d = sel ? dayOf(sel) : undefined, ods = sel ? odsOf(sel) : [], lv = sel ? lvOf(sel) : undefined, hol = sel ? holOf(sel) : undefined, abs = sel ? absOf(sel) : false;
  const marked = sel && (abs || !!lv?.mark);   // a day HR marked: the staff member may question it
  const q = sel ? qOf(sel) : undefined;
  const send = async () => {
    if (!sel || !ask || ask.trim().length < 2) return;
    setBusy(true);
    try { const id = await api.raiseQuery(sel, ask.trim()); toast('Query sent to HR'); setAsk(null); setTick((t) => t + 1); setOpen(id); }
    catch (e) { toast(e instanceof ApiError && e.code === 'already_raised' ? 'A query for this day is already open.' : 'Could not send. Try again.'); }
    setBusy(false);
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button className="rbtn" style={{ width: 36, height: 36, visibility: ym > firstYm ? 'visible' : 'hidden' }} onClick={() => shift(-1)} aria-label="Previous month"><Icon n="chevL" /></button>
        <b style={{ fontSize: 15 }}>{new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b>
        <button className="rbtn" style={{ width: 36, height: 36, visibility: ym < lastYm ? 'visible' : 'hidden' }} onClick={() => shift(1)} aria-label="Next month"><Icon n="chevR" /></button>
      </div>
      <div className="cal">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <span className="dw" key={i}>{w}</span>)}
        {Array.from({ length: first }, (_, i) => <button key={`b${i}`} className="blank" aria-hidden="true" />)}
        {Array.from({ length: len }, (_, i) => i + 1).map((n) => {
          const k = key(n), wd = new Date(Date.UTC(y, mo - 1, n)).getUTCDay(), st = m ? state(k) : null, h = holOf(k);
          return <button key={n} className={`${k === todayKey ? 'today' : ''} ${wd === 0 || wd === 6 ? 'off' : ''} ${h ? (h.kind === 'office' ? 'hoff' : 'hol') : ''} ${k === sel ? 'sel' : ''}`}
            onClick={() => { setSel(k); setAsk(null); }} aria-label={`${n}${h ? `, ${h.kind === 'office' ? 'Office leave' : 'Holiday'}: ${h.name}` : ''}`}>
            {n}<i style={{ background: st ? DOT[st] : 'transparent' }} /></button>;
        })}
      </div>
      <div className="legend">
        {LEGEND.map(([k, l]) => <span key={k}><i style={{ background: DOT[k] }} />{l}{m ? ` ${counts[k] ?? 0}` : ''}</span>)}
        <span><i className="sq" style={{ background: '#ECEBFB', boxShadow: 'inset 0 0 0 1px #4B46B0' }} />Holiday {hols.filter((h) => h.kind !== 'office').length}</span>
        <span><i className="sq" style={{ background: '#FFF0E3', boxShadow: 'inset 0 0 0 1px #9A4B12' }} />Office leave {hols.filter((h) => h.kind === 'office').length}</span>
      </div>
      {!m && <div className="center" style={{ height: 40 }}><span className="spin dark" /></div>}
      {sel && m && (
        <div style={{ borderTop: '1px solid var(--ph-line)', marginTop: 10, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <b style={{ fontSize: 14 }}>{new Date(`${sel}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</b>
          {d ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className={`chip ${d.band ? CHIP[d.band] : 'c-pend'}`}>In {fmtTime(d.in)}</span>
            {d.out ? <span className={`chip ${outChip(d.out)}`}>Out {fmtTime(d.out)}</span> : <span className="chip c-pend">No out</span>}
          </div> : !lv && !hol && !abs && ods.length === 0 && <span style={{ fontSize: 13.5, color: 'var(--ph-ink3)' }}>No punch</span>}
          {hol && <span className="chip c-pend" style={{ alignSelf: 'flex-start' }}>{hol.kind === 'office' ? 'Office leave' : 'Holiday'} · {hol.name}</span>}
          {abs && <span className="chip c-bad" style={{ alignSelf: 'flex-start' }}>Marked absent by HR</span>}
          {ods.map((o, i) => <div key={i} className="row" style={{ padding: 0 }}><div className="ri c-od"><Icon n="brief" /></div>
            <div className="t"><b>{o.subject}</b><span>{o.venue} · {fmtTime(o.starts_at)} – {fmtTime(o.ends_at)}</span></div><span className={`chip ${o.status === 'approved' ? 'c-ok' : 'c-pend'}`}>{cap(o.status)}</span></div>)}
          {lv && <div className="row" style={{ padding: 0 }}><div className="ri c-lv"><Icon n="leaf" /></div>
            <div className="t"><b>{cap(lv.type)} leave{lv.half_day ? ` · ${lv.half_day}` : ''}{lv.by_hr ? ' · marked by HR' : ''}</b><span>{lv.from === lv.to ? '1 day' : `${lv.from.slice(8)} – ${lv.to.slice(8)}`}</span></div><span className={`chip ${lv.status === 'approved' ? 'c-ok' : 'c-pend'}`}>{cap(lv.status)}</span></div>}
          {q && <button className="chip-btn" onClick={() => setOpen(q.id)}><span className={`chip ${Q[q.status]?.[1] ?? 'c-pend'}`}>{q.clarify && q.status === 'pending' ? (me ? 'Query · reply needed' : 'Query · asked staff') : Q[q.status]?.[0] ?? 'Query'}</span><span className="more" style={{ margin: 0 }}>Timeline ›</span></button>}
          {me && marked && (!q || q.status !== 'pending') && (ask === null
            ? <button className="btn light" style={{ height: 44 }} onClick={() => setAsk('')}><Icon n="help" />Raise query</button>
            : <><textarea className="inp" style={{ minHeight: 76 }} maxLength={1000} placeholder="What’s wrong with this mark?" value={ask} onChange={(e) => setAsk(e.target.value)} />
              <div className="two"><button className="btn light" onClick={() => setAsk(null)}>Cancel</button><button className="btn dark" disabled={busy || ask.trim().length < 2} onClick={send}>{busy ? 'Sending' : 'Send to HR'}</button></div></>)}
        </div>)}
      {open && <RequestSheet kind="mark" id={open} onClose={() => { setOpen(null); setTick((t) => t + 1); }} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  );
}
