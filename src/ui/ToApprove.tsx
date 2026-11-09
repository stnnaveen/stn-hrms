import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, type MyApprovals } from '../lib/api';
import { fmtShortDay, fmtTime } from '../lib/time';
import { Icon } from './Icon';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Staff app: leave and OD waiting for me as someone's reporting person. Hidden when there is none. */
export function ToApprove() {
  const { toast } = useApp();
  const [a, setA] = useState<MyApprovals | null>(null);
  const [ret, setRet] = useState<{ kind: 'od' | 'leave'; id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.myApprovals().then(setA).catch(() => setA(null));
  useEffect(() => { load(); }, []);
  const decide = async (kind: 'od' | 'leave', id: string, d: 'approved' | 'returned', reason?: string) => {
    setBusy(id);
    try { await api.decide(kind, id, d, reason); toast(d === 'approved' ? 'Approved' : 'Returned'); setRet(null); load(); }
    catch { toast('Could not save. Try again.'); }
    setBusy(null);
  };
  const n = (a?.od.length ?? 0) + (a?.leave.length ?? 0);
  if (!a || n === 0) return null;
  const acts = (kind: 'od' | 'leave', id: string) => ret?.id === id
    ? <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><input className="inp" style={{ flex: 1 }} maxLength={300} placeholder="Reason to return" value={ret.reason} onChange={(e) => setRet({ kind, id, reason: e.target.value })} />
        <button className="btn dark" style={{ width: 'auto', padding: '0 16px' }} disabled={!ret.reason.trim() || busy === id} onClick={() => decide(kind, id, 'returned', ret.reason.trim())}>Return</button></div>
    : <div className="acts"><button className="btn light" disabled={busy === id} onClick={() => setRet({ kind, id, reason: '' })}>Return</button><button className="btn dark" disabled={busy === id} onClick={() => decide(kind, id, 'approved')}><Icon n="check" />Approve</button></div>;
  return (<>
    <div className="sec">To approve · {n}</div>
    <div className="list">
      {a.leave.map((l) => (
        <div className="req" key={l.id}>
          <div className="hd"><div className="t"><b>{l.who}</b><span>{cap(l.type)} leave</span></div><span className="chip c-lv">Leave</span></div>
          {l.reason && <p className="bd">{l.reason}</p>}
          <div className="meta"><span className="chip c-pend">{l.from === l.to ? fmtShortDay(new Date(l.from)) : `${fmtShortDay(new Date(l.from))} to ${fmtShortDay(new Date(l.to))}`}{l.half_day ? ` · ${l.half_day} half` : ''}</span></div>
          {acts('leave', l.id)}
        </div>))}
      {a.od.map((o) => (
        <div className="req" key={o.id}>
          <div className="hd"><div className="t"><b>{o.who}</b><span>{o.venue}</span></div><span className="chip c-od">OD</span></div>
          <p className="bd">{o.subject}</p>
          <div className="meta"><span className="chip c-pend">{fmtShortDay(new Date(o.starts_at))} · {fmtTime(o.starts_at)} to {fmtTime(o.ends_at)}</span></div>
          {acts('od', o.id)}
        </div>))}
    </div>
  </>);
}
