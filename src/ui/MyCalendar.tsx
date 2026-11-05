import { useEffect, useState } from 'react';
import { api, type MyMonth } from '../lib/api';
import { fmtTime, outChip } from '../lib/time';
import { Icon } from './Icon';

const BAND: Record<string, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)' };
const CHIP: Record<string, string> = { ok: 'c-ok', warn: 'c-warn', bad: 'c-bad' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const istKey = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);

/** Staff: own month — punch in / out, OD and leave. Tap a day for its times. Nothing else (CLAUDE.md rule 2). */
export function MyCalendar() {
  const now = new Date(Date.now() + 330 * 60000), todayKey = now.toISOString().slice(0, 10);
  const [ym, setYm] = useState(todayKey.slice(0, 7));
  const [m, setM] = useState<MyMonth | null>(null);
  const [sel, setSel] = useState<string>(todayKey);
  useEffect(() => { setM(null); api.myMonth(`${ym}-01`).then(setM).catch(() => setM({ month: ym, days: [], od: [], leave: [] })); }, [ym]);
  const [y, mo] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(), len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const key = (n: number) => `${ym}-${String(n).padStart(2, '0')}`;
  const shift = (d: number) => { const t = new Date(Date.UTC(y, mo - 1 + d, 1)); setYm(t.toISOString().slice(0, 7)); setSel(''); };
  const canNext = ym < todayKey.slice(0, 7);
  const dayOf = (k: string) => m?.days.find((x) => x.day === k);
  const odsOf = (k: string) => (m?.od ?? []).filter((o) => istKey(o.starts_at) <= k && istKey(o.ends_at) >= k);
  const lvOf = (k: string) => (m?.leave ?? []).find((l) => l.from <= k && l.to >= k);
  const dot = (k: string) => { const lv = lvOf(k); if (lv && lv.status === 'approved') return 'var(--lv)'; const d = dayOf(k); if (d?.band) return BAND[d.band]; if (odsOf(k).some((o) => o.status === 'approved')) return 'var(--od)'; return null; };
  const d = sel ? dayOf(sel) : undefined, ods = sel ? odsOf(sel) : [], lv = sel ? lvOf(sel) : undefined;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button className="rbtn" style={{ width: 36, height: 36 }} onClick={() => shift(-1)} aria-label="Previous month"><Icon n="chevL" /></button>
        <b style={{ fontSize: 15 }}>{new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b>
        <button className="rbtn" style={{ width: 36, height: 36, visibility: canNext ? 'visible' : 'hidden' }} onClick={() => shift(1)} aria-label="Next month"><Icon n="chevR" /></button>
      </div>
      <div className="cal">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <span className="dw" key={i}>{w}</span>)}
        {Array.from({ length: first }, (_, i) => <button key={`b${i}`} className="blank" aria-hidden="true" />)}
        {Array.from({ length: len }, (_, i) => i + 1).map((n) => {
          const k = key(n), wd = new Date(Date.UTC(y, mo - 1, n)).getUTCDay(), c = dot(k);
          return <button key={n} className={`${k === todayKey ? 'today' : ''} ${wd === 0 || wd === 6 ? 'off' : ''} ${k === sel ? 'sel' : ''}`} onClick={() => setSel(k)} aria-label={`${n}`}>
            {n}<i style={{ background: c ?? 'transparent' }} /></button>;
        })}
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />On time</span><span><i style={{ background: 'var(--warn)' }} />Slightly late</span><span><i style={{ background: 'var(--bad)' }} />Late</span>
        <span><i style={{ background: 'var(--od)' }} />OD</span><span><i style={{ background: 'var(--lv)' }} />Leave</span>
      </div>
      {sel && m && (
        <div style={{ borderTop: '1px solid var(--ph-line)', marginTop: 10, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <b style={{ fontSize: 14 }}>{new Date(`${sel}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</b>
          {d ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className={`chip ${d.band ? CHIP[d.band] : 'c-pend'}`}>In {fmtTime(d.in)}</span>
            {d.out ? <span className={`chip ${outChip(d.out)}`}>Out {fmtTime(d.out)}</span> : <span className="chip c-pend">No out</span>}
          </div> : !lv && ods.length === 0 && <span style={{ fontSize: 13.5, color: 'var(--ph-ink3)' }}>No punch</span>}
          {ods.map((o, i) => <div key={i} className="row" style={{ padding: 0 }}><div className="ri c-od"><Icon n="brief" /></div>
            <div className="t"><b>{o.subject}</b><span>{o.venue} · {fmtTime(o.starts_at)} – {fmtTime(o.ends_at)}</span></div><span className={`chip ${o.status === 'approved' ? 'c-ok' : 'c-pend'}`}>{cap(o.status)}</span></div>)}
          {lv && <div className="row" style={{ padding: 0 }}><div className="ri c-lv"><Icon n="leaf" /></div>
            <div className="t"><b>{cap(lv.type)} leave{lv.half_day ? ` · ${lv.half_day}` : ''}</b><span>{lv.from === lv.to ? '1 day' : `${lv.from.slice(8)} – ${lv.to.slice(8)}`}</span></div><span className={`chip ${lv.status === 'approved' ? 'c-ok' : 'c-pend'}`}>{cap(lv.status)}</span></div>}
        </div>)}
    </div>
  );
}
