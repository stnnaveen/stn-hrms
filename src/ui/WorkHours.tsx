import { useEffect, useState } from 'react';
import { hr, type PresenceDay } from '../lib/hr';
import { fmtTime } from '../lib/time';
import { fmtDistance } from '../lib/geo';

const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/** Store app: the day's time inside / outside the radius, each trip out, and gaps with no signal.
 *  For HR, Chairman and Tech only (CLAUDE.md rule 2). Shows nothing for people without the store app. */
export function WorkHours({ userId }: { userId: string }) {
  const [d, setD] = useState<PresenceDay | null>(null);
  useEffect(() => { hr.presenceDay(userId).then(setD).catch(() => setD(null)); }, [userId]);
  if (!d?.tracked || !d.samples) return null;
  const total = Math.max(1, d.inside_min + d.outside_min + d.od_min + d.no_signal_min);
  const seg = (m: number, c: string) => (m > 0 ? <i style={{ width: `${(m / total) * 100}%`, background: c, borderRadius: 0 }} /> : null);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="qhd"><span>Work hours · {fmtTime(d.from!)} – {fmtTime(d.to!)}</span><b style={{ fontSize: 20, whiteSpace: 'nowrap', color: d.outside_min ? 'var(--bad-ink)' : 'var(--ok-ink)' }}>{d.outside_min ? `Out ${mins(d.outside_min)}` : 'Inside'}</b></div>
      <div className="bar" style={{ display: 'flex', height: 12 }}>{seg(d.inside_min, 'var(--ok)')}{seg(d.outside_min, 'var(--bad)')}{seg(d.od_min, 'var(--od)')}{seg(d.no_signal_min, '#C9CBD2')}</div>
      <div className="mlegend">
        <span><i style={{ background: 'var(--ok)' }} />Inside {mins(d.inside_min)}</span>
        <span><i style={{ background: 'var(--bad)' }} />Outside {mins(d.outside_min)}</span>
        {d.od_min > 0 && <span><i style={{ background: 'var(--od)' }} />OD {mins(d.od_min)}</span>}
        {d.no_signal_min > 0 && <span><i style={{ background: '#C9CBD2' }} />No signal {mins(d.no_signal_min)}</span>}
      </div>
      {d.trips.length > 0 && <div style={{ marginTop: 10 }}>{d.trips.map((t, i) => (
        <div key={i} className="row" style={{ padding: '6px 0', fontSize: 14 }}>
          <span className="t"><b style={{ fontSize: 14 }}>{fmtTime(t.from)} – {t.ongoing ? 'now' : fmtTime(t.to)}</b><span>{mins(t.min)}{t.max_m ? ` · up to ${fmtDistance(t.max_m)} away` : ''}</span></span>
          {t.ongoing && <span className="chip c-bad">Still out</span>}
        </div>))}</div>}
      {d.no_signal_min >= 15 && <p className="to" style={{ textAlign: 'left', margin: '8px 0 0' }}>No signal = phone off, app closed or location turned off.</p>}
    </div>
  );
}
