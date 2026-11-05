import { useEffect, useState } from 'react';
import { bio, type BioPersonDay } from '../lib/bio';
import { fmtShortDay, fmtTime } from '../lib/time';

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const CHIP: Record<string, string> = { ok: 'c-ok', warn: 'c-warn', bad: 'c-bad' };

/** Fingerprint days from the eSSL device, last 7 days: in (first punch) and out (after 20 min). HR only.
 *  Works before the person signs in; shows nothing when there is no matched eSSL code or no punches. */
export function BioPunches({ email }: { email: string }) {
  const [rows, setRows] = useState<BioPersonDay[] | null>(null);
  useEffect(() => { bio.personDays(email, 7).then(setRows).catch(() => setRows(null)); }, [email]);
  if (!rows?.length) return null;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="qhd"><span>Fingerprint · 7 days</span><b style={{ fontSize: 15 }}>eSSL</b></div>
      {rows.map((r) => (
        <div key={r.day} className="row" style={{ padding: '6px 0', fontSize: 14 }}>
          <span className="t"><b style={{ fontSize: 14 }}>{r.day === istToday() ? 'Today' : fmtShortDay(new Date(`${r.day}T12:00:00+05:30`))}</b><span>{r.out_at ? `Out ${fmtTime(r.out_at)}` : 'No out punch'}</span></span>
          <span className={`chip ${CHIP[r.band] ?? 'c-pend'}`}>In {fmtTime(r.in_at)}</span>
        </div>))}
    </div>
  );
}
