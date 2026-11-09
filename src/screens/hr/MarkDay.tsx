// HR > person: mark a day Absent or Leave (or clear it). The person is told; the change is audited.
import { useEffect, useState } from 'react';
import { useApp } from '../../App';
import { ApiError } from '../../lib/api';
import { hr, type DayMark } from '../../lib/hr';

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const TYPES = [['casual', 'Casual'], ['sick', 'Sick'], ['earned', 'Earned'], ['other', 'Other']] as const;

export function MarkDay({ email, name, onSaved }: { email: string; name: string; onSaved?: () => void }) {
  const { toast } = useApp();
  const [day, setDay] = useState(istToday());
  const [cur, setCur] = useState<DayMark | null | undefined>(undefined);
  const [type, setType] = useState('casual');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCur(undefined); hr.markOf(email, day).then((m) => { setCur(m); setNote(m?.note ?? ''); if (m?.leave_type) setType(m.leave_type); }).catch(() => setCur(null)); }, [email, day]);
  const save = async (mark: 'absent' | 'leave' | null) => {
    setBusy(true);
    try { await hr.setDayMark(email, day, mark, mark === 'leave' ? type : undefined, note.trim() || undefined); toast(mark ? `${mark === 'absent' ? 'Absent' : 'Leave'} marked · ${name.split(' ')[0]} notified` : 'Cleared'); setCur(mark ? { email, day, mark, leave_type: mark === 'leave' ? type : null, note } : null); onSaved?.(); }
    catch (e) { toast(e instanceof ApiError ? e.code.charAt(0).toUpperCase() + e.code.slice(1) : 'Could not save'); }
    setBusy(false);
  };
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="inp" type="date" aria-label="Day" value={day} max={new Date(Date.now() + 330 * 60000 + 90 * 864e5).toISOString().slice(0, 10)} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ flex: 1 }} />
        {cur && <span className={`chip ${cur.mark === 'absent' ? 'c-bad' : 'c-lv'}`}>{cur.mark === 'absent' ? 'Absent' : `Leave · ${cur.leave_type}`}</span>}
      </div>
      <div className="seg" role="group" aria-label="Leave type" style={{ marginTop: 10 }}>{TYPES.map(([v, l]) => <button key={v} className={type === v ? 'on' : ''} onClick={() => setType(v)}>{l}</button>)}</div>
      <input className="inp" style={{ marginTop: 10 }} maxLength={200} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn light" disabled={busy || day > istToday()} onClick={() => save('absent')}>Absent</button>
        <button className="btn dark" disabled={busy} onClick={() => save('leave')}>Leave</button>
        {cur && <button className="btn ghost" disabled={busy} onClick={() => save(null)}>Clear</button>}
      </div>
    </div>
  );
}
