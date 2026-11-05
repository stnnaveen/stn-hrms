// Tech admin > Setup > Biometric: the eSSL sync PC (link key, is it reporting), which hub each device is in,
// and matching eSSL staff codes to the staff list. Fingerprint punches are evidence only for now.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App';
import { ApiError } from '../../lib/api';
import { bio, bioAge, bioState, suggest, type BioOverview, type BioPerson } from '../../lib/bio';
import { fmtShortDay, fmtTime } from '../../lib/time';
import { copyText } from '../../device';
import { Icon } from '../../ui/Icon';

const ago = (s: number | null) => (s == null ? 'Never' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`);
const when = (iso: string | null | undefined) => (iso ? `${fmtShortDay(new Date(iso))} ${fmtTime(iso)}` : '—');
const err = (e: unknown) => (e instanceof ApiError ? e.code : 'Could not save. Try again.');

export function Biometric({ onBack }: { onBack: () => void }) {
  const { toast } = useApp();
  const [o, setO] = useState<BioOverview | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [, tick] = useState(0);
  const load = () => bio.overview().then(setO).catch(() => toast('Could not load'));
  useEffect(() => { load(); const t = setInterval(load, 30000), c = setInterval(() => tick((x) => x + 1), 5000); return () => { clearInterval(t); clearInterval(c); }; }, []);

  const make = async () => {
    setBusy('key');
    try { setKey(await bio.newKey(o?.link?.name ?? 'Chennai office')); setConfirm(false); load(); } catch (e) { toast(err(e)); }
    setBusy(null);
  };
  const copy = async () => toast((await copyText(key ?? '')) ? 'Copied' : 'Select and copy it');
  const setHub = async (dev: number, hub: string) => { if (!o?.link) return; setBusy(`d${dev}`); try { await bio.setHub(o.link.id, dev, hub || null); toast('Saved'); load(); } catch (e) { toast(err(e)); } setBusy(null); };
  const match = async (p: BioPerson, email: string | null) => { setBusy(p.code); try { await bio.match(p.linkId, p.code, email); toast(email ? 'Matched' : 'Cleared'); load(); } catch (e) { toast(err(e)); } setBusy(null); };

  const taken = useMemo(() => new Set((o?.people ?? []).map((p) => p.email).filter((x): x is string => !!x)), [o]);
  const unmatched = (o?.people ?? []).filter((p) => !p.email);
  const matched = (o?.people ?? []).filter((p) => p.email);
  const nameOf = (email: string | null) => o?.roster.find((r) => r.email === email)?.name ?? email ?? '';
  const st = bioState(o?.link ?? null), age = bioAge(o?.link ?? null);
  const info = o?.link?.info ?? {};

  return (
    <div className="scr fade" style={{ paddingBottom: 40 }}>
      <div className="ttl"><button className="rbtn" onClick={onBack} aria-label="Back"><Icon n="chevL" /></button><div className="mid"><small>Setup</small><b>Biometric</b></div><span className="sp" /></div>
      {!o ? <div className="center" style={{ height: 200 }}><span className="spin dark" /></div> : <>
        <div className="sec" style={{ marginTop: 0 }}>Sync PC</div>
        <div className="card" style={{ padding: '6px 16px' }}>
          <div className="svc"><span className={`dot ${!o.link || age == null ? 'off' : st === 'ok' ? '' : st === 'warn' ? 'p' : 'bad'}`} /><span className="t">{o.link ? (info.pc ?? o.link.name) : 'Not linked'}<span>{o.link ? `Last report ${ago(age)}${info.version ? ` · v${info.version}` : ''}` : 'Make a link key, then run Install.bat on the eSSL PC'}</span></span><span className="ms">{o.link ? (age == null ? 'Waiting' : st === 'ok' ? 'Live' : st === 'warn' ? 'Late' : 'Down') : 'Off'}</span></div>
          {o.link && <div className="svc"><span className="dot off" /><span className="t">Fingerprint punches today<span>Last punch {when(info.last_punch)}</span></span><span className="ms">{o.today}</span></div>}
          {o.link && info.last_error && <div className="svc"><span className="dot bad" /><span className="t">Last error<span>{info.last_error}</span></span></div>}
        </div>

        <div className="sec">Link key</div>
        {key ? (
          <div className="card" style={{ padding: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--ph-ink3)', margin: '0 0 8px' }}>Shown once. Paste it into Install.bat on the eSSL PC.</p>
            <div style={{ font: '500 12.5px var(--mono)', wordBreak: 'break-all', background: 'var(--ph-bg)', borderRadius: 12, padding: 12, userSelect: 'all' }}>{key}</div>
            <div className="acts" style={{ marginTop: 12, display: 'flex', gap: 8 }}><button className="btn light" onClick={() => setKey(null)}>Done</button><button className="btn dark" onClick={copy}><Icon n="check" />Copy</button></div>
          </div>
        ) : confirm ? (
          <div className="card" style={{ padding: 16 }}>
            <p style={{ fontSize: 14, margin: '0 0 12px' }}>The current key stops working. The eSSL PC needs the new one.</p>
            <div style={{ display: 'flex', gap: 8 }}><button className="btn light" onClick={() => setConfirm(false)}>Cancel</button><button className="btn dark" disabled={busy === 'key'} onClick={make}>New key</button></div>
          </div>
        ) : (
          <div className="card" style={{ padding: '6px 16px' }}>
            <button className="setrow" onClick={() => (o.link ? setConfirm(true) : make())} disabled={busy === 'key'}><span className="ri c-od"><Icon n="key" /></span><span className="t"><b>{o.link ? 'New key' : 'Make key'}</b><span>{o.link ? `Current key made ${when(o.link.createdAt)}` : 'For the eSSL PC, shown once'}</span></span><Icon n="chevR" /></button>
          </div>
        )}

        {o.devices.length > 0 && <>
          <div className="sec">Devices · {o.devices.filter((d) => d.kind === 'biometric').length}</div>
          {o.devices.filter((d) => d.kind === 'biometric' || showAll).map((d) => (
            <div className="lrow" key={d.esslId} style={{ flexWrap: 'wrap' }}>
              <span className="t"><b>{d.name}</b><span>{d.serial ?? d.kind}{d.lastPing ? ` · seen ${when(d.lastPing)}` : ''}</span></span>
              <select className="inp" style={{ width: 150 }} aria-label={`Hub for ${d.name}`} disabled={busy === `d${d.esslId}`} value={d.hubId ?? ''} onChange={(e) => setHub(d.esslId, e.target.value)}>
                <option value="">No hub</option>{o.hubs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>))}
          {o.devices.some((d) => d.kind !== 'biometric') && <button className="more" style={{ display: 'block', margin: '8px auto 0' }} onClick={() => setShowAll((x) => !x)}>{showAll ? 'Fingerprint devices only' : 'Show manual and mobile entries'}</button>}
        </>}

        {o.people.length > 0 && <>
          <div className="sec">Not matched · {unmatched.length}</div>
          {unmatched.length === 0 ? <p className="more" style={{ textAlign: 'left', marginTop: 0 }}>Every eSSL code is matched to the staff list.</p> : unmatched.map((p) => {
            const s = suggest(p, o.roster, taken);
            return (
              <div className="lrow" key={p.code} style={{ flexWrap: 'wrap' }}>
                <span className="t"><b>{p.esslName ?? 'No name'}</b><span>eSSL {p.esslCode ?? p.code}{s ? ` · likely ${s.name}` : ''}</span></span>
                {s && <button className="btn dark" style={{ width: 'auto', padding: '0 14px', height: 36 }} disabled={busy === p.code} onClick={() => match(p, s.email)}>Match</button>}
                <select className="inp" style={{ width: s ? 120 : 170 }} aria-label={`Staff for ${p.esslName ?? p.code}`} disabled={busy === p.code} value="" onChange={(e) => e.target.value && match(p, e.target.value)}>
                  <option value="">{s ? 'Other' : 'Choose'}</option>{o.roster.filter((r) => !taken.has(r.email)).map((r) => <option key={r.email} value={r.email}>{r.name}{r.code ? ` · ${r.code}` : ''}</option>)}
                </select>
              </div>);
          })}
          <div className="sec">Matched · {matched.length}</div>
          {matched.map((p) => (
            <div className="lrow" key={p.code}>
              <span className="t"><b>{nameOf(p.email)}</b><span>eSSL {p.esslCode ?? p.code} · {p.esslName ?? ''} · {p.matched === 'auto' ? 'same code' : 'by hand'}</span></span>
              <button className="rbtn" aria-label={`Unmatch ${nameOf(p.email)}`} disabled={busy === p.code} onClick={() => match(p, null)}><Icon n="x" /></button>
            </div>))}
        </>}
        <p className="to">The eSSL PC sends new punches every 30 seconds. Fingerprint punches show to HR; they do not change attendance yet.</p>
      </>}
    </div>
  );
}
