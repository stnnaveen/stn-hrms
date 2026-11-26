// Tech admin > Setup > Fingerprint report: every person in eSSL (Chennai sync), every day of a chosen range,
// with in, out, no out, absent, leave, OD, holiday and week off. Every eSSL entry of a day opens on tap.
// The server builds each day (bio_report); this screen only shows and exports it.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App';
import { ApiError } from '../../lib/api';
import { bio, type BioReportRow, type BioStatus } from '../../lib/bio';
import { fmtShortDay, fmtTime, outChip } from '../../lib/time';
import { writeXlsx, type Cell } from '../../lib/xlsx';
import { Icon } from '../../ui/Icon';

const ist = (ms = Date.now()) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const dayName = (d: string) => (d === ist() ? 'Today' : fmtShortDay(new Date(`${d}T12:00:00+05:30`)));
const mins = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const dur = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const MAX_DAYS = 93;

const ST: Record<BioStatus, { l: string; c: string }> = {
  present: { l: 'Present', c: 'c-ok' }, no_out: { l: 'No out', c: 'c-warn' }, absent: { l: 'Absent', c: 'c-bad' },
  leave: { l: 'Leave', c: 'c-lv' }, od: { l: 'OD', c: 'c-od' }, holiday: { l: 'Holiday', c: 'c-pend' }, week_off: { l: 'Week off', c: 'c-mute' }
};
const BAND = { ok: 'var(--ok-ink)', warn: 'var(--warn-ink)', bad: 'var(--bad-ink)' } as const;
const OUTC: Record<string, string> = { 'c-bad': 'var(--bad-ink)', 'c-ok': 'var(--ok-ink)', 'c-great': '#0B4F2A' };
type Filter = 'all' | 'present' | 'no_out' | 'absent' | 'away';
const inFilter = (s: BioStatus, f: Filter) => f === 'all' || (f === 'away' ? s === 'leave' || s === 'od' : s === f);

function presets() {
  const t = ist(), d = new Date(`${t}T12:00:00Z`), mon = addDays(t, -((d.getUTCDay() + 6) % 7));
  const m1 = `${t.slice(0, 8)}01`, lastEnd = addDays(m1, -1), lastStart = `${lastEnd.slice(0, 8)}01`;
  return [
    { k: 'today', l: 'Today', f: t, t }, { k: 'yday', l: 'Yesterday', f: addDays(t, -1), t: addDays(t, -1) },
    { k: 'week', l: 'This week', f: mon, t }, { k: 'month', l: 'This month', f: m1, t }, { k: 'last', l: 'Last month', f: lastStart, t: lastEnd }
  ];
}

export function FingerprintReport({ onBack }: { onBack: () => void }) {
  const { toast } = useApp();
  const P = useMemo(presets, []);
  const [from, setFrom] = useState(P[3].f);
  const [to, setTo] = useState(P[3].t);
  const [rows, setRows] = useState<BioReportRow[] | null>(null);
  const [f, setF] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'day' | 'person'>('day');
  const [open, setOpen] = useState<string | null>(null);
  const [showQuiet, setShowQuiet] = useState(false);

  const span = Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 864e5);
  const bad = !from || !to || span < 0 ? 'From must be on or before To.' : span >= MAX_DAYS ? `Pick ${MAX_DAYS} days or fewer.` : '';
  useEffect(() => {
    if (bad) return;
    setRows(null); setOpen(null);
    bio.report(from, to).then(setRows).catch((e) => { setRows([]); toast(e instanceof ApiError && e.code === 'range_too_long' ? `Pick ${MAX_DAYS} days or fewer.` : 'Could not load'); });
  }, [from, to]);

  const match = (r: BioReportRow) => {
    const s = q.trim().toLowerCase();
    return !s || [r.name, r.esslName, r.esslCode, r.code, r.email].some((x) => (x ?? '').toLowerCase().includes(s));
  };
  // eSSL entries not matched to staff and with no punch in the range (usually people who left): hidden unless asked
  const quiet = useMemo(() => {
    const seen = new Set((rows ?? []).filter((r) => r.punches > 0 || r.email).map((r) => r.code));
    return new Set((rows ?? []).filter((r) => !seen.has(r.code)).map((r) => r.code));
  }, [rows]);
  const scoped = (rows ?? []).filter((r) => (showQuiet || !quiet.has(r.code)) && match(r));
  const count = (fn: (s: BioStatus) => boolean) => scoped.filter((r) => fn(r.status)).length;
  const tiles: { k: Filter; l: string; n: number; c?: string }[] = [
    { k: 'present', l: 'Present', n: count((s) => s === 'present' || s === 'no_out'), c: 'var(--ok-ink)' },
    { k: 'absent', l: 'Absent', n: count((s) => s === 'absent'), c: 'var(--bad-ink)' },
    { k: 'no_out', l: 'No out', n: count((s) => s === 'no_out'), c: 'var(--warn-ink)' }
  ];
  const list = scoped.filter((r) => (f === 'present' ? r.status === 'present' || r.status === 'no_out' : inFilter(r.status, f)));
  const people = new Set(scoped.map((r) => r.code)).size, matched = new Set(scoped.filter((r) => r.email).map((r) => r.code)).size;

  // by person: totals over the range
  const byPerson = useMemo(() => {
    const m = new Map<string, { r: BioReportRow; days: BioReportRow[] }>();
    for (const r of scoped) { const x = m.get(r.code) ?? { r, days: [] }; x.days.push(r); m.set(r.code, x); }
    return [...m.values()].map(({ r, days }) => {
      const c = (s: BioStatus[]) => days.filter((d) => s.includes(d.status)).length;
      const late = days.filter((d) => d.band === 'bad').length;
      return { r, days, present: c(['present', 'no_out']), absent: c(['absent']), noOut: c(['no_out']), away: c(['leave', 'od']), off: c(['holiday', 'week_off']), late };
    }).filter((p) => f === 'all' || p.days.some((d) => (f === 'present' ? d.status === 'present' || d.status === 'no_out' : inFilter(d.status, f))))
      .sort((a, b) => b.absent - a.absent || (a.r.name ?? a.r.esslName ?? '').localeCompare(b.r.name ?? b.r.esslName ?? ''));
  }, [rows, q, f, showQuiet, quiet]);

  // HR sheet format (Excel): one row pair per staff member (punch in / punch out), a column pair per date (time, working hrs / remarks).
  // The date's box (both columns, both rows) is red when: no entry, under 6 working hours, or no punch out on a past day.
  const csv = () => {
    const list2 = scoped, dates = [...new Set(list2.map((r) => r.day))].sort();
    const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    const head = ['Sl.no', 'Staff Name', 'Designation', 'Staff code'];
    dates.forEach((d, i) => head.push(`${i === 0 ? 'Date ' : ''}(${dmy(d)})`, 'Working hrs / Remarks'));
    const people = [...new Map(list2.map((r) => [r.code, r])).values()]
      .sort((a, b) => (a.name ?? a.esslName ?? '').localeCompare(b.name ?? b.esslName ?? ''));
    const out: Cell[][] = [];
    people.forEach((p, n) => {
      const l1: Cell[] = [n + 1, p.name ?? p.esslName ?? '', p.designation ?? '', p.staffCode ?? p.esslCode ?? p.code];
      const l2: Cell[] = ['', '', '', ''];
      for (const d of dates) {
        const r = list2.find((x) => x.code === p.code && x.day === d);
        if (!r) { l1.push('', ''); l2.push('', ''); continue; }
        const late = r.band === 'bad' ? 'Late entry' : '';
        const extra = r.note ? r.note : '';
        if (r.inAt) {
          const early = r.outAt && outChip(r.outAt) === 'c-bad' ? 'Early check out' : '';
          const noOut = !r.outAt ? (r.status === 'no_out' ? 'No punch out' : 'Still in') : '';
          const rem = [late, early, noOut].filter(Boolean).join(' / ');
          const red = r.outAt ? mins(r.inAt, r.outAt) < 360 : r.status === 'no_out';
          const box = (v: string): Cell => (red ? { v: v || ' ', red: true } : v);
          l1.push(box(`${hm(r.inAt)} (punch in)`), box(r.outAt ? `${dur(mins(r.inAt, r.outAt)).replace(/h (\d+)m/, ':$1')} Hrs` : '-'));
          l2.push(box(r.outAt ? `${hm(r.outAt)} (punch out)` : noOut.toLowerCase()), box([rem, r.outAt && mins(r.inAt, r.outAt) < 360 ? 'Under 6 hrs' : '', extra].filter(Boolean).join(' / ') || '-'));
        } else {
          const word = r.status === 'absent' ? 'no entry' : r.status === 'week_off' ? 'week off' : r.status === 'holiday' ? 'holiday' : r.status === 'leave' ? 'leave' : 'OD';
          if (r.status === 'absent') { l1.push({ v: word, red: true }, { v: '-', red: true }); l2.push({ v: ' ', red: true }, { v: extra || ' ', red: true }); }
          else { l1.push(word, '-'); l2.push('', extra); }
        }
      }
      out.push(l1, l2);
    });
    const blob = writeXlsx([{ name: 'Fingerprint report', rows: [head, ...out], widths: [6, 24, 18, 12, ...dates.flatMap(() => [18, 26])], freezeCols: 4, noFilter: true }]);
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `fingerprint-report-${from}-to-${to}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const who = (r: BioReportRow) => r.name ?? r.esslName ?? r.code;
  const inOut = (r: BioReportRow) => r.inAt ? (
    <b><span style={{ color: BAND[r.band ?? 'ok'] }}>{fmtTime(r.inAt)}</span>{r.outAt ? <> – <span style={{ color: OUTC[outChip(r.outAt)] }}>{fmtTime(r.outAt)}</span></> : null}</b>) : null;
  const entries = (r: BioReportRow) => (
    <div style={{ padding: '2px 0 10px 2px' }}>
      {r.entries.length === 0 ? <p className="to" style={{ textAlign: 'left', margin: 0 }}>No entry in eSSL this day.</p>
        : r.entries.map((e, i) => (
          <div key={i} className="svc" style={{ padding: '4px 0' }}><span className={`dot ${e.kind === 'biometric' ? '' : 'p'}`} />
            <span className="t">{fmtTime(e.at)}<span>{e.device ?? 'Device'}{e.kind !== 'biometric' ? ` · ${e.kind === 'manual' ? 'Manual entry' : 'Mobile entry'}, not counted` : ''}{e.dir ? ` · ${e.dir}` : ''}</span></span></div>))}
    </div>);
  const dayRow = (r: BioReportRow, showDay: boolean) => {
    const k = `${r.day}|${r.code}`;
    return (
      <div key={k}>
        <button className="lrow" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
          <span className="t">
            <b>{showDay ? dayName(r.day) : who(r)}{!showDay && !r.email && <span className="chip c-warn" style={{ marginLeft: 6, fontSize: 11, display: 'inline-flex', width: 'auto', verticalAlign: 'middle' }}>Not matched</span>}</b>
            <span style={{ whiteSpace: 'normal' }}>{showDay ? '' : `eSSL ${r.esslCode ?? r.code}${r.hub ? ` · ${r.hub}` : ''}`}{r.inAt && r.outAt ? `${showDay ? '' : ' · '}${dur(mins(r.inAt, r.outAt))}` : ''}{r.note ? `${showDay && !(r.inAt && r.outAt) ? '' : ' · '}${r.note}` : ''}</span>
          </span>
          <span className="v" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
            <span className={`chip ${ST[r.status].c}`}>{ST[r.status].l}</span>{inOut(r)}
          </span>
        </button>
        {open === k && entries(r)}
      </div>);
  };

  const days = [...new Set(list.map((r) => r.day))];
  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>eSSL · Chennai</small><b>Fingerprint report</b></div>
        <button className="rbtn" onClick={csv} aria-label="Download Excel" disabled={!rows?.length}><Icon n="down" /></button></div>

      <div className="pillrow" role="group" aria-label="Range">
        {P.map((p) => <button key={p.k} className={`pill ${from === p.f && to === p.t ? 'on' : ''}`} style={{ whiteSpace: 'nowrap' }} onClick={() => { setFrom(p.f); setTo(p.t); }}>{p.l}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <label style={{ flex: 1 }}><span className="to" style={{ display: 'block', textAlign: 'left', margin: '0 0 6px 4px' }}>From</span>
          <input className="inp" type="date" value={from} max={ist()} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label style={{ flex: 1 }}><span className="to" style={{ display: 'block', textAlign: 'left', margin: '0 0 6px 4px' }}>To</span>
          <input className="inp" type="date" value={to} max={ist()} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      {bad && <p className="to" style={{ color: 'var(--bad-ink)', textAlign: 'left', margin: '8px 4px 0' }}>{bad}</p>}
      <input className="inp" style={{ marginTop: 10 }} placeholder="Search name or eSSL code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />

      {!bad && (!rows ? <div className="center" style={{ height: 200 }}><span className="spin dark" /></div> : <>
        <div className="tiles" style={{ marginTop: 12 }}>
          {tiles.map((t) => (
            <button key={t.k} className="tile" onClick={() => setF(f === t.k ? 'all' : t.k)} style={{ outline: f === t.k ? '2px solid var(--ph-navy)' : 'none', textAlign: 'left' }}>
              <b style={{ color: t.n ? t.c : undefined }}>{t.n}</b><span>{t.l}</span></button>))}
        </div>
        <p className="to" style={{ textAlign: 'left', margin: '8px 4px 0' }}>{people} in eSSL · {matched} matched to staff · {span + 1} day{span ? 's' : ''}{f !== 'all' ? ` · showing ${tiles.find((t) => t.k === f)?.l ?? ''}` : ''}
          {quiet.size > 0 && <> · <button style={{ color: 'var(--ok)', font: 'inherit' }} onClick={() => setShowQuiet(!showQuiet)}>{showQuiet ? `Hide ${quiet.size} not matched with no entry` : `Show ${quiet.size} not matched with no entry`}</button></>}</p>
        <div className="pillrow" role="group" aria-label="View" style={{ marginTop: 10 }}>
          <button className={`pill ${view === 'day' ? 'on' : ''}`} onClick={() => { setView('day'); setOpen(null); }}>By day</button>
          <button className={`pill ${view === 'person' ? 'on' : ''}`} onClick={() => { setView('person'); setOpen(null); }}>By person</button>
          <button className={`pill ${f === 'away' ? 'on' : ''}`} onClick={() => setF(f === 'away' ? 'all' : 'away')}>Leave / OD</button>
        </div>

        {rows.length === 0 ? <div className="empty"><b>No one in eSSL</b>Check the sync in Biometric.</div>
          : view === 'day' ? (list.length === 0 ? <div className="empty"><b>Nothing here</b>Try another filter.</div> : days.map((d) => (
            <div key={d}>
              <div className="sec" style={{ margin: '18px 0 8px' }}>{dayName(d)}<small style={{ color: 'var(--ph-ink3)' }}>{list.filter((r) => r.day === d && (r.status === 'present' || r.status === 'no_out')).length} in · {list.filter((r) => r.day === d && r.status === 'absent').length} absent</small></div>
              <div className="card" style={{ padding: '4px 14px' }}>{list.filter((r) => r.day === d).map((r) => dayRow(r, false))}</div>
            </div>)))
          : (byPerson.length === 0 ? <div className="empty"><b>Nothing here</b>Try another filter.</div> : (
            <div className="card" style={{ padding: '4px 14px', marginTop: 12 }}>{byPerson.map((p) => {
              const k = `p|${p.r.code}`;
              return (
                <div key={k}>
                  <button className="lrow" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
                    <span className="t"><b>{who(p.r)}{!p.r.email && <span className="chip c-warn" style={{ marginLeft: 6, fontSize: 11, display: 'inline-flex', width: 'auto', verticalAlign: 'middle' }}>Not matched</span>}</b>
                      <span>eSSL {p.r.esslCode ?? p.r.code}{p.r.hub ? ` · ${p.r.hub}` : ''}{p.late ? ` · late ${p.late}` : ''}{p.away ? ` · leave/OD ${p.away}` : ''}{p.off ? ` · off ${p.off}` : ''}</span></span>
                    <span className="v" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                      <span className="chip c-ok">Present {p.present}</span>
                      {p.absent > 0 && <span className="chip sm c-bad">Absent {p.absent}</span>}
                      {p.noOut > 0 && <span className="chip sm c-warn">No out {p.noOut}</span>}
                    </span>
                  </button>
                  {open === k && <div style={{ padding: '0 0 8px 8px' }}>{p.days.map((r) => dayRow(r, true))}</div>}
                </div>);
            })}</div>))}
        <p className="to">In = first fingerprint punch. Out = last punch 20+ min later. In: green to 10:00, yellow to 10:05, red after. Out: red before 6 PM. Manual and mobile eSSL entries are listed but not counted. Absent = no punch on a working day with no leave, OD or holiday. Tap a row for every eSSL entry.</p>
      </>)}
    </div>
  );
}
