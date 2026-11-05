// HR > Fingerprint (test): eSSL punches from the 1st of the month, per person per day — first punch (in) and
// last punch (out), with the app check-in beside it, so HR can check the eSSL codes are matched to the right people.
// Evidence only: nothing here changes attendance.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App';
import { bio, type BioDayRow, type BioCheck } from '../../lib/bio';
import { fmtShortDay, fmtTime, outChip } from '../../lib/time';
import { toCsv, download } from '../../lib/csv';
import { Icon } from '../../ui/Icon';

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayName = (d: string) => (d === istToday() ? 'Today' : fmtShortDay(new Date(`${d}T12:00:00+05:30`)));
const mins = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const BAND = { ok: { c: 'var(--ok-ink)', l: 'On time' }, warn: { c: 'var(--warn-ink)', l: 'Slightly late' }, bad: { c: 'var(--bad-ink)', l: 'Late' } } as const;
const OUTC = { 'c-bad': 'var(--bad-ink)', 'c-ok': 'var(--ok-ink)', 'c-great': '#0B4F2A' } as const;
const dur = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;

export function Fingerprint({ onBack }: { onBack: () => void }) {
  const { toast } = useApp();
  const today = istToday(), first = `${today.slice(0, 8)}01`;
  const [rows, setRows] = useState<BioDayRow[] | null>(null);
  const [checks, setChecks] = useState<BioCheck[] | null>(null);
  const [day, setDay] = useState<string>('all');
  const [f, setF] = useState<'all' | 'matched' | 'none'>('all');
  const load = () => { bio.range(first, today).then(setRows).catch(() => { setRows([]); toast('Could not load'); }); bio.verify(first, today).then(setChecks).catch(() => setChecks([])); };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);

  const days = useMemo(() => [...new Set((rows ?? []).map((r) => r.day))].sort().reverse(), [rows]);
  const inDay = (rows ?? []).filter((r) => day === 'all' || r.day === day);
  const list = inDay.filter((r) => (f === 'all' ? true : f === 'matched' ? !!r.email : !r.email));
  const people = new Set(inDay.map((r) => r.code)).size, matched = new Set(inDay.filter((r) => r.email).map((r) => r.code)).size;

  // three checks against eSSL itself, for the selected day(s)
  const ck = (checks ?? []).filter((c) => c.stored_rows > 0 && (day === 'all' || c.day === day));
  const reported = ck.some((c) => c.essl_rows != null);
  const rowsOk = ck.every((c) => c.essl_rows === c.stored_rows), orph = ck.reduce((a, c) => a + c.orphans, 0);
  const filled = ck.reduce((a, c) => a + (c.essl_filled ?? 0), 0);
  const cmp = ck.reduce((a, c) => a + c.compared, 0), inOk = ck.reduce((a, c) => a + c.in_agree, 0), outOk = ck.reduce((a, c) => a + c.out_agree, 0);
  const diff = new Map(ck.flatMap((c) => c.differ.map((x) => [`${c.day}|${x.code}`, x] as const)));
  const allOk = reported && rowsOk && orph === 0 && cmp > 0 && inOk === cmp && outOk === cmp;
  const csv = () => download(`fingerprint-${first}-to-${today}.csv`, toCsv(
    ['date', 'essl_code', 'essl_name', 'staff_name', 'staff_email', 'in', 'colour', 'out', 'punches', 'hours', 'app_check_in', 'app_check_out'],
    (rows ?? []).map((r) => [r.day, r.esslCode ?? r.code, r.esslName, r.name, r.email, fmtTime(r.first), BAND[r.band].l, r.last ? fmtTime(r.last) : '', r.punches, r.last ? dur(mins(r.first, r.last)) : '', r.appIn ? fmtTime(r.appIn) : '', r.appOut ? fmtTime(r.appOut) : ''])));

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
        {checks && <div className="card" style={{ padding: '6px 16px', marginTop: 10, boxShadow: allOk ? undefined : 'inset 0 0 0 2px var(--warn)' }}>
          <div className="qhd" style={{ margin: '6px 0' }}><span>Checked against eSSL</span><b style={{ fontSize: 15, color: allOk ? 'var(--ok-ink)' : 'var(--warn-ink)' }}>{!reported ? 'Waiting' : allOk ? 'All match' : 'Check'}</b></div>
          {!reported ? <p className="to" style={{ textAlign: 'left', margin: '0 0 8px' }}>Update the sync on the eSSL PC (v1.1) to turn on this check.</p> : <>
            <div className="svc"><span className={`dot ${rowsOk ? '' : 'bad'}`} /><span className="t">Every eSSL punch received<span>eSSL {ck.reduce((a, c) => a + (c.essl_rows ?? 0), 0)} · here {ck.reduce((a, c) => a + c.stored_rows, 0)}</span></span></div>
            <div className="svc"><span className={`dot ${orph === 0 ? '' : 'bad'}`} /><span className="t">Every punch linked to an eSSL person<span>{orph === 0 ? 'None left over' : `${orph} not linked`}</span></span></div>
            <div className="svc"><span className={`dot ${cmp && inOk === cmp && outOk === cmp ? '' : cmp ? 'bad' : 'p'}`} /><span className="t">In and out same as eSSL’s own report<span>{cmp ? `In ${inOk}/${cmp} · out ${outOk}/${cmp}` : 'eSSL has not processed these days yet'}</span></span></div>
            {filled > 0 && <p className="to" style={{ textAlign: 'left', margin: '2px 0 8px' }}>{filled} with no out punch: eSSL’s own report fills in 18:00 for them. That is not a punch; here they show “No out punch”.</p>}
          </>}
        </div>}
        {list.length === 0 ? <div className="empty"><b>No punches</b>Try another day or filter.</div> : list.map((r) => {
          return (
            <div className="lrow" key={`${r.day}-${r.code}`}>
              <span className="t">
                <b>{r.name ?? r.esslName ?? r.code}{!r.email && <span className="chip c-warn" style={{ marginLeft: 6, fontSize: 11, display: 'inline-flex', width: 'auto', verticalAlign: 'middle' }}>Not matched</span>}</b>
                <span style={{ whiteSpace: 'normal' }}>{day === 'all' ? `${dayName(r.day)} · ` : ''}eSSL {r.esslCode ?? r.code}{r.email && r.esslName ? ` · ${r.esslName}` : ''} · {r.punches} punch{r.punches === 1 ? '' : 'es'}{r.appIn ? ` · app in ${fmtTime(r.appIn)}` : ''}{r.appOut ? `, out ${fmtTime(r.appOut)}` : ''}{diff.get(`${r.day}|${r.code}`) && <b style={{ display: 'inline', fontSize: 13, color: 'var(--bad-ink)' }}> · eSSL says {diff.get(`${r.day}|${r.code}`)!.essl_in ?? '—'}–{diff.get(`${r.day}|${r.code}`)!.essl_out ?? '—'}</b>}</span>
              </span>
              <span className="v"><b><span style={{ color: BAND[r.band].c, fontSize: 15 }}>{fmtTime(r.first)}</span>{r.last && <> – <span style={{ color: OUTC[outChip(r.last)], fontSize: 15 }}>{fmtTime(r.last)}</span></>}</b><span>{r.last ? dur(mins(r.first, r.last)) : 'No out punch'}</span></span>
            </div>);
        })}
        <p className="to">First punch = in. A punch 20+ min later = out; repeats inside 20 min are ignored. In: green to 10:00, yellow to 10:05, red after. Out: red before 6 PM, green from 6, dark green from 8.</p>
      </>}
    </div>
  );
}
