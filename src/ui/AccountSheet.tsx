import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';

// Opened from the avatar. Shows who is signed in and lets them log out (asks once to confirm).
export function AccountSheet({ name, sub, onClose }: { name: string; sub: string; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.session().then((s) => setEmail(s?.email ?? '')); }, []);
  const logout = async () => {
    setBusy(true);
    try { localStorage.removeItem('stn-greeted'); } catch { /* private mode */ }
    await api.signOut();
  };
  const ini = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="Account"><div className="grab" />
        <div className="row">
          <span className="av" aria-hidden="true">{ini}</span>
          <div className="t"><b style={{ fontSize: 18 }}>{name}</b><span>{sub}</span></div>
        </div>
        {email && <div className="card" style={{ marginTop: 16, boxShadow: 'none', background: 'var(--ph-surface)' }}>
          <dl className="kv" style={{ margin: 0 }}><dt>Signed in as</dt><dd>{email}</dd></dl></div>}
        {!confirm ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 20 }}>
            <button className="btn danger" onClick={() => setConfirm(true)}><Icon n="out" />Log out</button>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            <p style={{ marginTop: 18 }}>Log out of StartupTN HR?</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
              <button className="btn danger" disabled={busy} onClick={logout}>{busy ? 'Logging out' : 'Log out'}</button>
              <button className="btn ghost" onClick={() => setConfirm(false)}>Stay</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
