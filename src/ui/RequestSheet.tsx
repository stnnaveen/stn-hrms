import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../App';
import { api, ApiError, type ReqKind, type Timeline } from '../lib/api';
import { fmtShortDay, fmtTime } from '../lib/time';
import { Icon } from './Icon';

const ROLE: Record<string, string> = { staff: 'Staff', reporting: 'Reporting', hr: 'HR', chairman: 'Chairman', tech: 'Tech', system: 'System' };
const STEP: Record<string, [string, string, string]> = {   // label, icon, tint
  created: ['Raised', 'plus', 'c-pend'], assigned: ['Assigned by HR', 'leaf', 'c-lv'], clarify: ['Asked', 'help', 'c-warn'],
  reply: ['Replied', 'chat', 'c-od'], approved: ['Approved', 'check', 'c-ok'], returned: ['Returned', 'x', 'c-bad'],
  cancelled: ['Cancelled', 'x', 'c-pend'], pending: ['Reopened', 'clock', 'c-pend']
};
// a query on an HR mark: approve = correct the mark (removed), return = keep it
const MARK_STEP: Record<string, [string, string, string]> = { created: ['Query raised', 'help', 'c-warn'], approved: ['Corrected', 'check', 'c-ok'], returned: ['Kept', 'x', 'c-bad'] };
const when = (iso: string) => `${fmtShortDay(new Date(iso))} · ${fmtTime(iso)}`;

/** One leave or OD with its whole timeline. The approver (reporting person, HR or Chairman) can approve,
 *  return or ask; the staff member answers a question. HR and Chairman always see every step. */
export function RequestSheet({ kind, id, onClose, onChanged, start }: { kind: ReqKind; id: string; onClose: () => void; onChanged?: () => void; start?: 'ask' | 'return' | 'approve' }) {
  const { toast } = useApp();
  const [t, setT] = useState<Timeline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<null | 'ask' | 'return' | 'approve' | 'reply'>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.timeline(kind, id).then((x) => { setT(x); if (x.mine && x.clarify && x.status === 'pending') setMode('reply'); else if (start && x.can_decide && x.status === 'pending') setMode((m) => m ?? start); }).catch(() => setErr('Could not load.'));
  useEffect(() => { setT(null); setMode(null); setText(''); load(); }, [kind, id, start]); // eslint-disable-line react-hooks/exhaustive-deps
  const host = document.querySelector('.screen');
  if (!host) return null;

  const act = async () => {
    const v = text.trim();
    setBusy(true);
    try {
      if (mode === 'ask') { await api.ask(kind, id, v); toast('Question sent'); }
      else if (mode === 'reply') { await api.reply(kind, id, v); toast('Reply sent'); }
      else if (mode === 'return') { await api.decide(kind, id, 'returned', v); toast(kind === 'mark' ? 'Kept · staff notified' : 'Returned · staff notified'); }
      else if (mode === 'approve') { await api.decide(kind, id, 'approved', v || undefined); toast(kind === 'mark' ? 'Corrected · mark removed' : 'Approved · staff notified'); }
      setMode(null); setText(''); onChanged?.(); await load();
    } catch (e) { toast(e instanceof ApiError && e.code === 'not_allowed' ? 'This one is with another approver.' : 'Could not send. Try again.'); }
    setBusy(false);
  };

  const status = !t ? null : t.status !== 'pending' ? (t.kind === 'mark' ? (t.status === 'approved' ? 'Corrected' : t.status === 'returned' ? 'Kept' : t.status) : t.status) : t.clarify ? (t.mine ? 'Reply needed' : 'Asked staff') : t.can_decide ? 'Waiting for you' : `With ${t.with ?? 'approver'}`;
  const stCls = !t ? '' : t.status === 'approved' ? 'c-ok' : t.status === 'returned' ? 'c-bad' : t.clarify ? 'c-warn' : 'c-pend';
  const dates = !t ? '' : t.kind === 'od' && t.starts_at
    ? `${fmtShortDay(new Date(t.starts_at))} · ${fmtTime(t.starts_at)} to ${fmtTime(t.ends_at)}`
    : t.from ? (t.from === t.to ? fmtShortDay(new Date(t.from)) : `${fmtShortDay(new Date(t.from))} to ${fmtShortDay(new Date(t.to!))}`) + (t.half_day ? ` · ${t.half_day} half` : '') : '';
  const need = mode === 'ask' || mode === 'return' || mode === 'reply';
  const ph = mode === 'ask' ? 'Your question' : mode === 'return' ? (kind === 'mark' ? 'Why the mark stays' : 'Reason to return') : mode === 'reply' ? 'Your answer' : 'Comment (optional)';
  const M = kind === 'mark';
  const go = mode === 'ask' ? 'Ask' : mode === 'return' ? (M ? 'Keep' : 'Return') : mode === 'reply' ? 'Send' : (M ? 'Correct' : 'Approve');

  return createPortal(<>
    <div className="scrim" onClick={onClose} />
    <div className="sheet" role="dialog" aria-label={t?.title ?? 'Request'}><div className="grab" />
      <div className="scrollable">
        {!t ? (err ? <p>{err}</p> : <div className="center" style={{ height: 160 }}><span className="spin dark" /></div>) : <>
          <div className="row" style={{ padding: 0 }}>
            <div className={`ri ${t.kind === 'od' ? 'c-od' : t.kind === 'mark' ? 'c-warn' : 'c-lv'}`}><Icon n={t.kind === 'od' ? 'brief' : t.kind === 'mark' ? 'help' : 'leaf'} /></div>
            <div className="t"><b style={{ fontSize: 18 }}>{t.title}</b><span>{t.mine ? dates : `${t.who}${t.hub ? ` · ${t.hub}` : ''}`}</span></div>
            <span className={`chip ${stCls}`}>{status && status[0].toUpperCase() + status.slice(1)}</span>
          </div>
          {!t.mine && dates && <p style={{ marginTop: 10 }}>{dates}</p>}
          {t.kind === 'od' && t.venue && <p style={{ marginTop: 4 }}>{t.venue}</p>}

          <div className="sec">Timeline</div>
          <ol className="tline2">{t.events.map((e, i) => {
            const [label, icon, tint] = (M ? MARK_STEP[e.action] : undefined) ?? STEP[e.action] ?? [e.action, 'clock', 'c-pend'];
            return <li key={i}><span className={`ri ${tint}`}><Icon n={icon} size={16} /></span>
              <div><b>{label}</b> · {e.who} <span className="rl">{ROLE[e.role] ?? e.role}</span>
                <small>{when(e.at)}{e.action === 'created' && e.with ? ` · to ${e.with}` : ''}</small>
                {e.comment && <p className="cm">{e.comment}</p>}</div></li>;
          })}</ol>

          {mode && (<>
            <textarea className="inp" style={{ marginTop: 12, minHeight: 84 }} maxLength={mode === 'reply' ? 1000 : mode === 'ask' ? 500 : 300} placeholder={ph} value={text} onChange={(e) => setText(e.target.value)} />
            <div className={t.mine && mode === 'reply' ? '' : 'two'} style={{ marginTop: 10, display: t.mine && mode === 'reply' ? 'grid' : undefined }}>
              {!(t.mine && mode === 'reply') && <button className="btn light" onClick={() => { setMode(null); setText(''); }}>Cancel</button>}
              <button className="btn dark" disabled={busy || (need && text.trim().length < 2)} onClick={act}>{busy ? 'Sending' : go}</button>
            </div></>)}
          {!mode && t.can_decide && t.status === 'pending' && (
            <div className="acts" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
              <button className="btn light" onClick={() => setMode('ask')}><Icon n="help" />Ask</button>
              <button className="btn light" onClick={() => setMode('return')}>{M ? 'Keep' : 'Return'}</button>
              <button className="btn dark" onClick={() => setMode('approve')}><Icon n="check" />{M ? 'Correct' : 'Approve'}</button>
            </div>)}
        </>}
      </div>
      <button className="btn ghost" style={{ marginTop: 8 }} onClick={onClose}>Close</button>
    </div>
  </>, host);
}
