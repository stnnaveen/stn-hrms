import { useEffect, useState } from 'react';
import { bio } from '../lib/bio';
import { fmtShortDay, fmtTime } from '../lib/time';

const ist = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);

/** Fingerprint punches from the eSSL device, last 7 days: first and last per day. HR, Chairman, Tech only.
 *  Shows nothing when this person has no matched eSSL code or no punches. */
export function BioPunches({ userId }: { userId: string }) {
  const [rows, setRows] = useState<{ at: string; direction: string | null; device: string | null }[] | null>(null);
  useEffect(() => { bio.person(userId, 7).then(setRows).catch(() => setRows(null)); }, [userId]);
  if (!rows?.length) return null;
  const days = new Map<string, string[]>();
  for (const r of rows) { const k = ist(r.at); days.set(k, [...(days.get(k) ?? []), r.at]); }
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="qhd"><span>Fingerprint · 7 days</span><b style={{ fontSize: 15 }}>{rows[0].device ?? 'eSSL'}</b></div>
      {[...days.entries()].map(([k, ts]) => {
        const s = [...ts].sort();
        return (
          <div key={k} className="row" style={{ padding: '6px 0', fontSize: 14 }}>
            <span className="t"><b style={{ fontSize: 14 }}>{k === ist(new Date().toISOString()) ? 'Today' : fmtShortDay(new Date(s[0]))}</b><span>{s.length} punch{s.length > 1 ? 'es' : ''}</span></span>
            <span className="tm">{fmtTime(s[0])}{s.length > 1 ? ` – ${fmtTime(s[s.length - 1])}` : ''}</span>
          </div>);
      })}
    </div>
  );
}
