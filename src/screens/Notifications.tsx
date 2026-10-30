import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, type Notif } from '../lib/api';
import { Icon } from '../ui/Icon';

const KIND: Record<string, [string, string]> = {
  od_approved: ['c-ok', 'check'], od_returned: ['c-bad', 'x'], leave_approved: ['c-ok', 'check'], leave_returned: ['c-bad', 'x'],
  leave_assigned: ['c-lv', 'leaf'], reason_asked: ['c-warn', 'alert']
};

function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export function Notifications() {
  const { back } = useApp();
  const [list, setList] = useState<Notif[] | null>(null);
  useEffect(() => { api.notifications().then(setList); }, []);
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <div className="ttl">
        <button className="rbtn" onClick={back} aria-label="Back"><Icon n="chevL" /></button>
        <div className="mid"><small>Updates</small><b>Notifications</b></div>
        <button className="rbtn" aria-label="Mark all read" onClick={async () => { await api.markAllRead(); setList(await api.notifications()); }}><Icon n="check" /></button>
      </div>
      {list === null && <div className="center" style={{ height: 200 }}><span className="spin dark" /></div>}
      {list?.length === 0 && <p className="to">Nothing yet.</p>}
      {list?.map((n) => {
        const [c, i] = KIND[n.kind] ?? ['c-pend', 'bell'];
        return (
          <div className={`nt ${n.read_at ? '' : 'unread'}`} key={n.id}>
            <div className={`ri ${c}`}><Icon n={i} /></div>
            <div className="t"><b>{n.title}</b>{n.body && <span>{n.body}</span>}</div>
            <time>{ago(n.created_at)}</time>
          </div>
        );
      })}
    </div>
  );
}
