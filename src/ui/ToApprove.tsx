import { useEffect, useState } from 'react';
import { api, type MyApprovals } from '../lib/api';
import { fmtShortDay, fmtTime } from '../lib/time';
import { Icon } from './Icon';
import { RequestSheet } from './RequestSheet';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
type Open = { kind: 'od' | 'leave'; id: string; start?: 'ask' | 'return' | 'approve' };

/** Staff app: leave and OD waiting for me as someone's reporting person. Approve, return or ask; the timeline
 *  (with every comment) is shared with HR and the Chairman. Hidden when there is none. */
export function ToApprove() {
  const [a, setA] = useState<MyApprovals | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const load = () => api.myApprovals().then(setA).catch(() => setA(null));
  useEffect(() => { load(); }, []);
  const n = (a?.od.length ?? 0) + (a?.leave.length ?? 0);
  if (!a || n === 0) return null;
  const acts = (kind: 'od' | 'leave', id: string, asked?: boolean) => (<>
    {asked && <div className="meta"><span className="chip c-warn">Asked · waiting for reply</span></div>}
    <div className="acts" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
      <button className="btn light" onClick={() => setOpen({ kind, id, start: 'ask' })}><Icon n="help" />Ask</button>
      <button className="btn light" onClick={() => setOpen({ kind, id, start: 'return' })}>Return</button>
      <button className="btn dark" onClick={() => setOpen({ kind, id, start: 'approve' })}><Icon n="check" />Approve</button>
    </div>
    <button className="more" style={{ display: 'block', margin: '8px auto 0' }} onClick={() => setOpen({ kind, id })}>Timeline</button></>);
  return (<>
    <div className="sec">To approve · {n}</div>
    <div className="list">
      {a.leave.map((l) => (
        <div className="req" key={l.id}>
          <div className="hd"><div className="t"><b>{l.who}</b><span>{cap(l.type)} leave</span></div><span className="chip c-lv">Leave</span></div>
          {l.reason && <p className="bd">{l.reason}</p>}
          <div className="meta"><span className="chip c-pend">{l.from === l.to ? fmtShortDay(new Date(l.from)) : `${fmtShortDay(new Date(l.from))} to ${fmtShortDay(new Date(l.to))}`}{l.half_day ? ` · ${l.half_day} half` : ''}</span></div>
          {acts('leave', l.id, l.clarify)}
        </div>))}
      {a.od.map((o) => (
        <div className="req" key={o.id}>
          <div className="hd"><div className="t"><b>{o.who}</b><span>{o.venue}</span></div><span className="chip c-od">OD</span></div>
          <p className="bd">{o.subject}</p>
          <div className="meta"><span className="chip c-pend">{fmtShortDay(new Date(o.starts_at))} · {fmtTime(o.starts_at)} to {fmtTime(o.ends_at)}</span></div>
          {acts('od', o.id, o.clarify)}
        </div>))}
    </div>
    {open && <RequestSheet kind={open.kind} id={open.id} start={open.start} onClose={() => { setOpen(null); load(); }} onChanged={load} />}
  </>);
}
