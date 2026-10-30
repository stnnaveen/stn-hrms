import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, type Notif } from '../lib/api';
import { Icon } from '../ui/Icon';

const KIND: Record<string, [string, string]> = {
  od_approved: ['c-ok', 'check'], od_returned: ['c-bad', 'x'], leave_approved: ['c-ok', 'check'], leave_returned: ['c-bad', 'x'],
  leave_assigned: ['c-lv', 'leaf'], reason_asked: ['c-warn', 'alert'], od_new: ['c-od', 'brief'], leave_new: ['c-lv', 'leaf'], device_new: ['c-pend', 'shield']
};

function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export function Notifications({ onBackOverride }: { onBackOverride?: () => void }) {
  const { back, toast } = useApp();
  const [list, setList] = useState<Notif[] | null>(null);
  const [reasonFor, setReasonFor] = useState<Notif | null>(null);
  const [reason, setReason] = useState('');
  const [answered, setAnswered] = useState<string[]>([]);
  useEffect(() => { api.notifications().then(setList); }, []);

  const send = async () => {
    if (!reasonFor?.data?.flag_id || !reason.trim()) return;
    try { await api.submitReason(reasonFor.data.flag_id, reason.trim()); setAnswered((a) => [...a, reasonFor.id]); setReasonFor(null); setReason(''); toast('Sent to HR'); }
    catch { toast('Could not send. Try again.'); }
  };

  return (
    <><div className="scr fade" style={{ paddingBottom: 40 }}>
      <div className="ttl">
        <button className="rbtn" onClick={onBackOverride ?? back} aria-label="Back"><Icon n="chevL" /></button>
        <div className="mid"><small>Updates</small><b>Notifications</b></div>
        <button className="rbtn" aria-label="Mark all read" onClick={async () => { await api.markAllRead(); setList(await api.notifications()); }}><Icon n="check" /></button>
      </div>
      {list === null && <div className="center" style={{ height: 200 }}><span className="spin dark" /></div>}
      {list?.length === 0 && <p className="to">Nothing yet.</p>}
      {list?.map((n) => {
        const [c, i] = KIND[n.kind] ?? ['c-pend', 'bell'];
        const ask = n.kind === 'reason_asked' && n.data?.flag_id && !answered.includes(n.id);
        return (
          <div className={`nt ${n.read_at ? '' : 'unread'}`} key={n.id} role={ask ? 'button' : undefined} onClick={ask ? () => setReasonFor(n) : undefined} style={ask ? { cursor: 'pointer' } : undefined}>
            <div className={`ri ${c}`}><Icon n={i} /></div>
            <div className="t"><b>{n.title}</b>{n.body && <span>{n.body}</span>}{ask && <span style={{ color: 'var(--ph-ink)', fontWeight: 600 }}>Tap to reply</span>}</div>
            <time>{ago(n.created_at)}</time>
          </div>
        );
      })}
    </div>
      {reasonFor && (<>
        <div className="scrim" onClick={() => setReasonFor(null)} />
        <div className="sheet" role="dialog" aria-label="Add a reason"><div className="grab" />
          <h3>Add a reason</h3><p>{reasonFor.body}</p>
          <textarea className="inp" style={{ marginTop: 16 }} placeholder="What happened?" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16 }}>
            <button className="btn dark" disabled={!reason.trim()} onClick={send}>Send</button>
            <button className="btn ghost" onClick={() => setReasonFor(null)}>Later</button>
          </div></div></>)}
    </>
  );
}
