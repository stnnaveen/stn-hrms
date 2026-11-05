// HR > Fingerprint (test): eSSL punches from the 1st of the month, per person per day — first punch (in) and
// last punch (out), with the app check-in beside it, so HR can check the eSSL codes are matched to the right people.
// Evidence only: nothing here changes attendance.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App';
import { bio, type BioDayRow } from '../../lib/bio';
import { fmtShortDay, fmtTime } from '../../lib/time';
import { toCsv, download } from '../../lib/csv';
import { Icon } from '../../ui/Icon';

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayName = (d: string) => (d === istToday() ? 'Today' : fmtShortDay(new Date(`${d}T12:00:00+05:30`)));
const mins = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const dur = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;

export function Fingerprint({ onBack }: { onBack: () => void }) {
  const { toast } = useApp();
  const today = istToday(), first = `${today.slice(0, 8)}01`;
  const [rows, setRows] = useState<BioDayRow[] | null>(null);
  const [day, setDay] = useState<string>('all');
  const [f, setF] = useState<'all' | 'matched' | 'none'>('all');
  const load = () => bio.range(first, today).then(setRows).catch(() => { setRows([]); toast('Could not load'); });
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);

  const days = useMemo(() => [...new Set((rows ?? []).map((r) => r.day))].sort().reverse(), [rows]);
  const inDay = (rows ?? []).filter((r) => day === 'all' || r.day === day);
  const list = inDay.filter((r) => (f === 'all' ? true : f === 'matched' ? !!r.email : !r.email));
  const people = new Set(inDay.map((r) => r.code)).size, matched = new Set(inDay.filter((r) => r.email).map((r) => r.code)).size;

  const csv = () => download(`fingerprint-${first}-to-${today}.csv`, toCsv(
    ['date', 'essl_code', 'essl_name', 'staff_name', 'staff_email', 'first_punch', 'last_punch', 'punches', 'hours', 'app_check_in', 'app_check_out'],
    (rows ?? []).map((r) => [r.day, r.esslCode ?? r.code, r.esslName, r.name, r.email, fmtTime(r.first), r.punches > 1 ? fmtTime(r.last) : '', r.punches, r.punches > 1 ? dur(mins(r.first, r.last)) : '', r.appIn ? fmtTime(r.appIn) : '', r.appOut ? fmtTime(r.appOut) : ''])));

  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>Test · eSSL Chennai</small><b>Fingerprint</b></div>
        <button className="rbtn" onClick={csv} aria-label="Download CSV" disabled={!rows?.length}><Icon n="down" /></button></div>
      <div className="pillrow" role="group" aria-label="Day" style={{ overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`pill ${day === 'all' ? 'on' : ''}`} onClick={() => setDay('all')}>All days</button>
        {days.map((d) => <button key={d} className={`pill ${day === d ? 'on' : ''}`} style={{ whiteSpace: 'nowrap' }} onClick={() => setDay(d)}>{dayName(d)}</button>)}
      </div>
      {!rows ? <div className="center" style={{ height: 200 }}><span className="spin dark" /></div> : <>
        <div className="tiles" style={{ marginTop: 4 }}>
          <button className="tile" onClick={() => setF('all')} style={{ outline: f === 'all' ? '2px solid var(--ph-navy)' : 'none' }}><b>{people}</b><span>People</span></button>
          <button className="tile" onClick={() => setF('matched')} style={{ outline: f === 'matched' ? '2px solid var(--ph-navy)' : 'none' }}><b>{matched}</b><span>Matched</span></button>
          <button className="tile" onClick={() => setF('none')} style={{ outline: f === 'none' ? '2px solid var(--ph-navy)' : 'none' }}><b style={{ color: people - matched ? 'var(--bad-ink)' : undefined }}>{people - matched}</b><span>Not matched</span></button>
        </div>
        {list.length === 0 ? <div className="empty"><b>No punches</b>Try another day or filter.</div> : list.map((r) => {
          const one = r.punches === 1;
          return (
            <div className="lrow" key={`${r.day}-${r.code}`}>
              <span className="t">
                <b>{r.name ?? r.esslName ?? r.code}{!r.email && <span className="chip c-warn" style={{ marginLeft: 6, fontSize: 11, display: 'inline-flex', width: 'auto', verticalAlign: 'middle' }}>Not matched</span>}</b>
                <span style={{ whiteSpace: 'normal' }}>{day === 'all' ? `${dayName(r.day)} · ` : ''}eSSL {r.esslCode ?? r.code}{r.email && r.esslName ? ` · ${r.esslName}` : ''} · {r.punches} punch{one ? '' : 'es'}{r.appIn ? ` · app in ${fmtTime(r.appIn)}` : ''}{r.appOut ? `, out ${fmtTime(r.appOut)}` : ''}</span>
              </span>
              <span className="v"><b>{fmtTime(r.first)}{one ? '' : ` – ${fmtTime(r.last)}`}</b><span>{one ? 'No out punch' : dur(mins(r.first, r.last))}</span></span>
            </div>);
        })}
        <p className="to">First punch = in, last punch = out. From the eSSL device, for testing; attendance is unchanged.</p>
      </>}
    </div>
  );
}
