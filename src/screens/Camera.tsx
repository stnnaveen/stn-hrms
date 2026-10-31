import { useEffect, useRef, useState } from 'react';
import { useApp } from '../App';
import { api, ApiError, DEMO, errorText } from '../lib/api';
import { trackFix, captureJpeg, openFrontCamera, stopCamera, type Fix } from '../device';
import type { Challenge } from '../device/face';
import { fmtTime, stamp } from '../lib/time';
import { placeLabel } from '../lib/geo';
import { Icon } from '../ui/Icon';
import { PermHelp } from '../ui/PermHelp';

type Phase = 'starting' | 'align' | 'challenge' | 'count' | 'saving' | 'error';
const CHALLENGE_TEXT = { blink: 'Blink once', turn: 'Turn your head a little' };

export function Camera() {
  const { camMode, go, setResult, today, reload } = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [count, setCount] = useState(3);
  const [flash, setFlash] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [challenge] = useState<Challenge>(() => (Math.random() < 0.5 ? 'blink' : 'turn'));
  const [noCam, setNoCam] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => { if (phase !== 'saving') return; const t = setTimeout(() => setSlow(true), 12000); return () => clearTimeout(t); }, [phase]);
  const out = camMode === 'out', visit = camMode === 'visit';

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0, cancelled = false;
    let livenessPassed = false, livenessKind: string = challenge;
    let fixP: Promise<Fix> = Promise.reject(new Error('no_fix'));
    fixP.catch(() => undefined);
    let bestSoFar: () => Fix | null = () => null;
    const tOpen = performance.now();
    api.warm();

    const run = async () => {
      // 1. camera first, then location: iPhone can drop a second prompt shown on top of the first
      try { stream = await openFrontCamera(video.current!); }
      catch (e) {
        const denied = (e as DOMException)?.name === 'NotAllowedError';
        if (DEMO && !denied) { noCamFlag.current = true; setNoCam(true); } // demo on a desktop without a camera
        else { setErr(denied ? 'camera_denied' : 'no_camera'); setPhase('error'); return; }
      }
      if (cancelled) return;
      const tr = trackFix(15000, 50);
      bestSoFar = tr.best;
      fixP = tr.done.then((f) => { if (!cancelled) setFix(f); return f; });
      fixP.catch(() => undefined);
      // 2. face guide + liveness (never blocks the person: falls through after a timeout)
      setPhaseBoth('align');
      // face model loads on demand so the first screen stays light
      const face = await import('../device/face').catch(() => null);
      let lm = null;
      try { if (!noCamRef() && face) lm = await Promise.race([face.loadFaceModel(), new Promise<null>((r) => setTimeout(() => r(null), 6000))]); } catch { lm = null; }
      if (lm && face && video.current && !cancelled) {
        let steady = 0;
        const tracker = new face.ChallengeTracker(challenge);
        const t0 = performance.now();
        await new Promise<void>((resolve) => {
          const loop = () => {
            if (cancelled) return resolve();
            const f = face.readFrame(lm!, video.current!);
            const el = performance.now() - t0;
            if (phaseRef.current === 'align') {
              steady = f.centred ? steady + 1 : 0;
              if (steady > 8 || el > 5000) setPhaseBoth('challenge');
            } else if (phaseRef.current === 'challenge') {
              if (tracker.feed(f)) { livenessPassed = true; return resolve(); }
              if (el > 13000) return resolve();
            }
            raf = requestAnimationFrame(loop);
          };
          raf = requestAnimationFrame(loop);
        });
      } else {
        livenessKind = 'unavailable'; livenessPassed = true;
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (cancelled) return;
      // 3. countdown and capture
      setPhaseBoth('count');
      for (const n of [3, 2, 1]) { setCount(n); await new Promise((r) => setTimeout(r, 650)); if (cancelled) return; }
      setFlash(true);
      const photo = noCamRef() ? await placeholderJpeg() : await captureJpeg(video.current!);
      stopCamera(stream);
      setPhaseBoth('saving');
      // 4. location (already running) and send. A reading within 75 m that's already in hand is used at once;
      //    otherwise wait for the GPS (up to its 15 s limit). (75 m keeps the radius check honest: accuracy is credited up to 100 m.)
      const tShot = performance.now();
      let f: Fix;
      try { const b = bestSoFar(); f = b && (b.accuracy ?? 999) <= 75 ? b : await fixP; }
      catch (e) {
        if (DEMO) f = { lat: 13.0108, lng: 80.2206, accuracy: 12, altitude: null, speed: null, mocked: null, at: new Date().toISOString() };
        else { setErr((e as Error).message === 'location_denied' ? 'location_denied' : 'no_fix'); setPhase('error'); return; }
      }
      try {
        const punch = await api.punch({
          kind: camMode, selfie: photo,
          location: { lat: f.lat, lng: f.lng, accuracy: f.accuracy, altitude: f.altitude, speed: f.speed, mocked: f.mocked },
          liveness: { challenge: livenessKind, passed: livenessPassed },
          timings: { capture_ms: Math.round(tShot - tOpen), gps_wait_ms: Math.round(performance.now() - tShot), before_send_ms: Math.round(performance.now() - tShot) }
        });
        setResult({ punch, photo: URL.createObjectURL(photo) });
        await reload();
        go('result');
      } catch (e) { setErr(e instanceof ApiError ? e.code : 'save_failed'); setPhase('error'); }
    };

    // refs so the async loop reads the latest values
    const noCamRef = () => noCamFlag.current;
    const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };
    run();
    return () => { cancelled = true; cancelAnimationFrame(raf); stopCamera(stream); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phaseRef = useRef<Phase>('starting');
  const noCamFlag = useRef(false);

  if (phase === 'error') {
    return (
      <div className="scr fade" style={{ paddingBottom: 30, display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginTop: 80, textAlign: 'center' }}>
          <div className="badge-r" style={{ background: 'var(--warn)', margin: '0 auto', border: 0 }}><Icon n="alert" /></div>
          <h2 style={{ fontSize: 24, fontWeight: 600, margin: '16px 0 6px' }}>Couldn’t {out ? 'check out' : 'check in'}</h2>
          <p className="sub">{errorText(err ?? 'save_failed')}</p>
        </div>
        {(err === 'location_denied' || err === 'camera_denied') && <PermHelp what={[err === 'location_denied' ? 'location' : 'camera']} />}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="btn dark" onClick={() => { go('home'); setTimeout(() => go('camera'), 0); }}>Try again</button>
          <button className="btn ghost" onClick={() => go('home')}>Back</button>
        </div>
      </div>
    );
  }

  const name = today?.profile.full_name ?? '';
  const code = today?.profile.employee_code ? ` · ${today.profile.employee_code}` : '';
  const hint = phase === 'starting' ? 'Opening camera' : phase === 'align' ? 'Keep your face in the frame' : phase === 'challenge' ? '' : phase === 'saving' ? (slow ? 'Slow network. Still saving…' : 'Saving') : 'Hold still';
  return (
    <div className="cam">
      <div className="view">
        <video ref={video} playsInline muted style={noCam ? { display: 'none' } : undefined} />
        {noCam && <DemoFace />}
      </div>
      <div className="mask" />
      <div className={`ring ${phase === 'count' || phase === 'saving' ? 'ok' : 'scan'}`} />
      {phase === 'challenge' && <div className="chal" aria-live="assertive">{CHALLENGE_TEXT[challenge]}</div>}
      {phase === 'count' && <div className="count" key={count} aria-live="assertive">{count}</div>}
      <div className="hint">{hint}</div>
      <div className="bar">
        <button className="x" onClick={() => go('home')} aria-label="Close"><Icon n="x" /></button>
        <b>{visit ? 'Venue check-in' : out ? 'Check out' : 'Check in'}</b><span style={{ width: 42 }} />
      </div>
      <div className="wm">
        <div className="loc">{fix ? <><Icon n="pin" size={16} />Location tagged</> : <><span className="spin" />Locating you</>}</div>
        {name}{code}<br />{stamp(new Date())}<br />
        {fix ? `${fix.lat.toFixed(5)}°N, ${fix.lng.toFixed(5)}°E` : '—'}
      </div>
      {flash && <div className="flash" onAnimationEnd={() => setFlash(false)} />}
    </div>
  );
}

export function Result() {
  const { result, go, today } = useApp();
  if (!result) { go('home'); return null; }
  const { punch, photo } = result;
  const out = punch.kind === 'out', visit = punch.kind === 'visit';
  const first = today?.profile.full_name.split(' ')[0] ?? '';
  const place = <PlaceText name={punch.place_name} lat={punch.lat} lng={punch.lng} />;
  let col: string, icon: string, title: string, msg: string;
  if (punch.queued) {
    col = 'var(--ph-navy)'; icon = 'wifiOff'; title = 'Saved offline'; msg = 'It will send when you’re back online.';
  } else if (visit) {
    col = 'var(--od, #2F62D9)'; icon = 'pin'; title = 'Venue check-in done'; msg = 'Saved for your OD.';
  } else if (!out) {
    const k = punch.band ?? 'ok';
    col = k === 'ok' ? 'var(--ok)' : k === 'warn' ? 'var(--warn)' : 'var(--bad)';
    icon = k === 'ok' ? 'check' : k === 'warn' ? 'clock' : 'alert';
    title = k === 'ok' ? 'You’re on time' : k === 'warn' ? 'Slightly late' : 'Late today';
    msg = k === 'ok' ? `Have a great day, ${first}.` : k === 'warn' ? 'No worries. See you by 10:00 AM tomorrow.' : 'Please be in by 10:00 AM. You’ve got this.';
  } else {
    col = punch.early_out ? 'var(--warn)' : 'var(--ph-navy)'; icon = punch.early_out ? 'clock' : 'moon';
    title = punch.early_out ? 'Early checkout' : 'Checked out';
    msg = punch.early_out ? 'Logged as early leave.' : 'Good work today. Rest well.';
  }
  return (
    <div className="scr" style={{ paddingBottom: 30 }}>
      <div className="res fade">
        <div className="shot"><img src={photo} alt="Your check-in selfie" />
          <div className="stamp">{today?.profile.full_name}{today?.profile.employee_code ? ` · ${today.profile.employee_code}` : ''} · {visit ? 'Venue' : out ? 'Check out' : 'Check in'}<br />
            {stamp(new Date(punch.server_time))}<br />{place}</div></div>
        <div className="badge-r" style={{ background: col }}><Icon n={icon} /></div>
        <h2>{title}</h2>
        <div className="big">{out ? 'Checked out' : visit ? 'At the venue' : 'Checked in'} at {fmtTime(punch.server_time)}</div>
        <p className="msg">{msg}</p>
        <div className="meta"><span className="chip c-pend"><Icon n="pin" size={14} />{place}</span></div>
        <div className="cta"><button className="btn dark" onClick={() => go('home')}>Done</button></div>
      </div>
    </div>
  );
}

/** Place name for the result: the server's name if it had one ready, else looked up on the phone (the server fills it in shortly). */
function PlaceText({ name, lat, lng }: { name: string | null; lat: number; lng: number }) {
  const [n, setN] = useState<string | null>(name);
  useEffect(() => { if (!name) placeLabel(lat, lng).then((x) => x && setN(x)); }, [name, lat, lng]);
  return <>{n ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`}</>;
}

function DemoFace() {
  return (
    <svg viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%' }} aria-hidden="true">
      <rect width="300" height="400" fill="#B8BEC9" /><path d="M40 400c4-78 52-118 110-118s106 40 110 118z" fill="#2B3A55" />
      <ellipse cx="150" cy="186" rx="54" ry="68" fill="#B98060" />
      <path d="M96 170c0-52 26-78 56-78 34 0 58 24 56 76-10-24-28-38-56-38-26 0-46 16-56 40z" fill="#1B1716" />
    </svg>
  );
}

async function placeholderJpeg(): Promise<Blob> {
  const c = document.createElement('canvas'); c.width = 600; c.height = 800;
  const g = c.getContext('2d')!;
  g.fillStyle = '#B8BEC9'; g.fillRect(0, 0, 600, 800);
  g.fillStyle = '#B98060'; g.beginPath(); g.ellipse(300, 372, 108, 136, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2B3A55'; g.beginPath(); g.ellipse(300, 820, 230, 250, 0, 0, Math.PI * 2); g.fill();
  return await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.8));
}
