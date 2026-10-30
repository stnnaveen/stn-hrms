import { useEffect, useRef, useState } from 'react';
import { useApp } from '../App';
import { api, ApiError, errorText } from '../lib/api';
import { fmtDay, greeting, istMinutesNow } from '../lib/time';
import { Icon, Logo } from '../ui/Icon';

export function Splash() {
  return (
    <div className="splash"><div className="logo"><Logo size={76} />
      <div className="word"><b>StartupTN</b> <span className="grad" style={{ fontStyle: 'normal' }}>HR</span></div></div></div>
  );
}

export function SignIn() {
  const { go, email, setEmail } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = /^\S+@\S+\.\S+$/.test(email);
  const send = async () => {
    setBusy(true); setErr(null);
    try { await api.sendCode(email.trim().toLowerCase()); go('code'); }
    catch (e) { setErr(errorText(e instanceof ApiError ? e.code : 'send_failed')); }
    finally { setBusy(false); }
  };
  return (
    <div className="scr fade" style={{ paddingBottom: 30 }}>
      <div className="pills" aria-hidden="true">
        <div className="fp" style={{ left: 70, top: 8 }}><Icon n="scan" />Selfie check-in</div>
        <div className="fp" style={{ left: 4, top: 72, animationDelay: '.08s' }}><Icon n="pin" />Location tag</div>
        <div className="fp" style={{ left: 92, top: 136, animationDelay: '.16s' }}><Icon n="brief" />OD and leave</div>
        <div className="fp" style={{ left: 150, top: 200, animationDelay: '.24s' }}><Icon n="cal" />Monthly log</div>
      </div>
      <span className="tag"><i />StartupTN HR</span>
      <h1 className="h1" style={{ marginTop: 14 }}>Attendance, made <span className="grad">simple</span>.</h1>
      <p className="sub">Check in with a selfie. Done in seconds.</p>
      <form style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }} onSubmit={(e) => { e.preventDefault(); if (valid && !busy) send(); }}>
        <label className="field" htmlFor="em"><Icon n="mail" />
          <input id="em" type="email" inputMode="email" autoComplete="email" placeholder="name@startuptn.in" value={email}
            onChange={(e) => setEmail(e.target.value)} aria-label="Work email" /></label>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn dark" type="submit" disabled={!valid || busy}>{busy ? 'Sending' : 'Continue'}</button>
        <div className="or">or</div>
        <button className="btn light" type="button" onClick={() => api.google()}><span className="gmark">G</span>Continue with Google</button>
      </form>
    </div>
  );
}

export function Code() {
  const { go, email, toast } = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(30);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000); return () => clearInterval(t); }, []);
  const verify = async (c = code) => {
    setBusy(true); setErr(null);
    try { await api.verifyCode(email.trim().toLowerCase(), c); }
    catch (e) { setErr(errorText(e instanceof ApiError ? e.code : 'bad_code')); setCode(''); }
    finally { setBusy(false); }
  };
  return (
    <div className="scr fade" style={{ paddingBottom: 30 }}>
      <button className="back" onClick={() => go('signin')}><Icon n="chevL" />Back</button>
      <h1 className="h1">Check your mail</h1>
      <p className="sub">Code sent to {email}</p>
      <div className="otpw" onClick={() => ref.current?.focus()}>
        <input ref={ref} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-label="6-digit code"
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) verify(v); }} />
        <div className="otp" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i}>{code[i] ?? ''}</span>)}</div>
      </div>
      {err && <div className="err" role="alert" style={{ marginTop: -12, marginBottom: 12 }}>{err}</div>}
      <button className="btn dark" disabled={code.length !== 6 || busy} onClick={() => verify()}>{busy ? 'Checking' : 'Verify'}</button>
      {left > 0
        ? <p className="to">Resend in 0:{String(left).padStart(2, '0')}</p>
        : <p className="to"><button style={{ color: 'var(--ph-ink)', fontWeight: 600 }} onClick={async () => { await api.sendCode(email); setLeft(30); toast('Code sent'); }}>Resend code</button></p>}
    </div>
  );
}

// DPDP Act consent before the first check-in (PRD FM-01)
export function Consent() {
  const { go, reload } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <div className="scr fade" style={{ paddingBottom: 30 }}>
      <span className="tag"><i />Before you start</span>
      <h1 className="h1" style={{ marginTop: 14 }}>Your data, <span className="grad">your consent</span>.</h1>
      <p className="sub">Used only for attendance at StartupTN.</p>
      <div className="card" style={{ marginTop: 22 }}>
        <div className="row"><div className="ri c-od"><Icon n="cam" /></div><div className="t"><b>Selfie</b><span>Each check-in. Kept 90 days.</span></div></div>
        <div className="row"><div className="ri c-lv"><Icon n="scan" /></div><div className="t"><b>Face match</b><span>Compared with your approved photo.</span></div></div>
        <div className="row"><div className="ri c-ok"><Icon n="pin" /></div><div className="t"><b>Location</b><span>Only when you check in or out.</span></div></div>
        <div className="row"><div className="ri c-pend"><Icon n="shield" /></div><div className="t"><b>Stored in India</b><span>Seen by HR and admins only.</span></div></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 22 }}>
        <button className="btn dark" disabled={busy} onClick={async () => { setBusy(true); await api.consent(); await reload(); go('welcome'); }}>I agree</button>
        <button className="btn ghost" onClick={() => api.signOut()}>Not now</button>
      </div>
    </div>
  );
}

export function Welcome() {
  const { go, today } = useApp();
  useEffect(() => { const t = setTimeout(() => go('home'), 3200); return () => clearTimeout(t); }, [go]);
  const m = istMinutesNow();
  const line = m < 720 ? 'Have a great day.' : m < 1020 ? 'Hope the day is going well.' : 'Almost done for today.';
  const first = today?.profile.full_name.split(' ')[0] ?? '';
  return (
    <div className="welcome" role="button" tabIndex={0} onClick={() => go('home')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && go('home')} aria-label="Continue to home">
      <div className="glow" />
      <div className="w1">{fmtDay()}</div>
      <div className="w2">{greeting()},<br />{first}.</div>
      <div className="w3">{line}</div>
      <div className="skip">Tap to continue</div>
    </div>
  );
}
