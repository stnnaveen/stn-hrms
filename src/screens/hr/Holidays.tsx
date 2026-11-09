// HR > Holidays: Tamil Nadu government holidays and office leave days. Everyone sees them on their calendar;
// they are not counted as "Not in". Only HR edits (save_holiday / delete_holiday, audited).
import { useEffect, useState } from 'react';
import { useApp } from '../../App';
import { ApiError } from '../../lib/api';
import { hr, type Holiday } from '../../lib/hr';
import { Icon } from '../../ui/Icon';

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const nice = (d: string) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

export function Holidays({ onBack }: { onBack: () => void }) {
  const { toast } = useApp();
  const [list, setList] = useState<Holiday[] | null>(null);
  const [year, setYear] = useState(Number(istToday().slice(0, 4)));
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ day: istToday(), name: '', kind: 'office' as 'govt' | 'office' });
  const [busy, setBusy] = useState(false);
  const load = () => hr.holidays(year).then((h) => setList(h.filter((x) => x.day.startsWith(String(year))))).catch(() => setList([]));
  useEffect(() => { setList(null); load(); }, [year]);
  const save = async () => {
    if (f.name.trim().length < 2) { toast('Add a name'); return; }
    setBusy(true);
    try { await hr.saveHoliday(f.day, f.name.trim(), f.kind); toast('Saved'); setAdd(false); setF({ day: istToday(), name: '', kind: 'office' }); load(); }
    catch (e) { toast(e instanceof ApiError ? e.code.replace(/^.*?:\s*/, '') : 'Could not save'); }
    setBusy(false);
  };
  const del = async (h: Holiday) => { try { await hr.deleteHoliday(h.day); toast('Removed'); load(); } catch { toast('Could not remove'); } };
  const months = new Map<string, Holiday[]>();
  for (const h of list ?? []) { const k = h.day.slice(0, 7); months.set(k, [...(months.get(k) ?? []), h]); }
  const today = istToday();
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>Tamil Nadu</small><b>Holidays</b></div>
        <button className="rbtn" onClick={() => setAdd((x) => !x)} aria-label="Add a day"><Icon n="plus" /></button></div>
      <div className="seg" role="group" aria-label="Year" style={{ marginBottom: 12 }}>
        {[year - 1, year, year + 1].map((y) => <button key={y} className={y === year ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}
      </div>
      {add && <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <label className="lab" htmlFor="h-d">Date</label><input className="inp" id="h-d" type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
        <label className="lab" htmlFor="h-n">Name</label><input className="inp" id="h-n" maxLength={80} value={f.name} placeholder="e.g. Office closed for audit" onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="seg" role="group" aria-label="Kind" style={{ marginTop: 12 }}>
          <button className={f.kind === 'office' ? 'on' : ''} onClick={() => setF({ ...f, kind: 'office' })}>Office leave</button>
          <button className={f.kind === 'govt' ? 'on' : ''} onClick={() => setF({ ...f, kind: 'govt' })}>Government</button>
        </div>
        <button className="btn dark" style={{ marginTop: 12 }} disabled={busy} onClick={save}>{busy ? 'Saving' : 'Save'}</button>
      </div>}
      {!list ? <div className="center" style={{ height: 160 }}><span className="spin dark" /></div> : list.length === 0 ? <div className="empty"><b>No holidays</b>Add one with +.</div> :
        [...months.entries()].map(([k, hs]) => (<div key={k}>
          <div className="sec">{new Date(`${k}-01T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>
          {hs.map((h) => (
            <div className="lrow" key={h.day} style={{ opacity: h.day < today ? 0.55 : 1 }}>
              <span className="t"><b>{h.name}</b><span>{nice(h.day)}</span></span>
              <span className={`chip ${h.kind === 'office' ? 'c-od' : 'c-lv'}`}>{h.kind === 'office' ? 'Office' : 'Govt'}</span>
              <button className="rbtn" aria-label={`Remove ${h.name}`} onClick={() => del(h)}><Icon n="x" /></button>
            </div>))}
        </div>))}
      <p className="to">Holidays show on every calendar and are not counted as “Not in”.</p>
    </div>
  );
}
