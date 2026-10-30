import { useApp } from '../App';
import { api } from '../lib/api';
import { Logo } from '../ui/Icon';

const NAMES: Record<string, string> = { hr: 'HR', chairman: 'Chairman', tech: 'Tech admin' };

// HR, Chairman and Tech admin screens arrive in the next slices; the backend for them is already live.
export function AdminSoon() {
  const { today } = useApp();
  const role = NAMES[today?.profile.role ?? ''] ?? 'Admin';
  return (
    <div className="center fade">
      <div>
        <Logo size={64} />
        <h1 className="h1" style={{ marginTop: 20, fontSize: 26 }}>{role} view is next.</h1>
        <p className="sub">Staff check-in is live first.</p>
        <button className="btn light" style={{ marginTop: 24 }} onClick={() => api.signOut()}>Sign out</button>
      </div>
    </div>
  );
}
