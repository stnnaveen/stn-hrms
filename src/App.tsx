import { firstViewToday, permsDone, permState } from './device';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, DEMO, type PunchResult, type Today } from './lib/api';
import { Icon } from './ui/Icon';
import { Splash, SignIn, Code, Consent, Permissions, Welcome } from './screens/Auth';
import { Home } from './screens/Home';
import { Camera, Result } from './screens/Camera';
import { ODForm, LeaveForm } from './screens/Forms';
import { Notifications } from './screens/Notifications';
import { AdminSoon } from './screens/AdminSoon';
import { HRApp } from './screens/hr/HRApp';
import { ChairApp } from './screens/chair/ChairApp';
import { TechApp } from './screens/tech/TechApp';

export type Screen = 'splash' | 'signin' | 'code' | 'consent' | 'perms' | 'welcome' | 'home' | 'camera' | 'result' | 'od' | 'leave' | 'notifs' | 'admin' | 'hr' | 'chair' | 'tech';

interface Ctx {
  screen: Screen;
  go: (s: Screen) => void;
  back: () => void;
  toast: (m: string) => void;
  email: string; setEmail: (e: string) => void;
  today: Today | null; reload: () => Promise<Today | null>;
  camMode: 'in' | 'out' | 'visit'; setCamMode: (m: 'in' | 'out' | 'visit') => void;
  result: { punch: PunchResult; photo: string } | null; setResult: (r: { punch: PunchResult; photo: string } | null) => void;
  odPrefill: { urgent: boolean } | null; setOdPrefill: (p: { urgent: boolean } | null) => void;
  leaveOd: string | null; setLeaveOd: (id: string | null) => void;   // check-out to go to this OD (not early leave)
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

const ADMIN_ROLES = ['hr', 'chairman', 'tech'];

export default function App() {
  const [screen, setScreen] = useState<Screen>('splash');
  const stack = useRef<Screen[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [today, setToday] = useState<Today | null>(null);
  const [camMode, setCamMode] = useState<'in' | 'out' | 'visit'>('in');
  const [result, setResult] = useState<{ punch: PunchResult; photo: string } | null>(null);
  const [odPrefill, setOdPrefill] = useState<{ urgent: boolean } | null>(null);
  const [leaveOd, setLeaveOd] = useState<string | null>(null);
  const toastTimer = useRef<number>();

  const go = useCallback((s: Screen) => {
    setScreen((cur) => {
      if (['home', 'signin', 'welcome', 'admin', 'hr', 'chair', 'tech'].includes(s)) stack.current = [];
      else if (cur !== s) { stack.current.push(cur); history.pushState({ s }, ''); }
      return s;
    });
  }, []);
  const back = useCallback(() => setScreen(stack.current.pop() ?? 'home'), []);
  useEffect(() => {
    const onPop = () => { if (stack.current.length) setScreen(stack.current.pop()!); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2400);
  }, []);

  const reload = useCallback(async () => {
    try { const t = await api.today(); setToday(t); return t; } catch { return null; }
  }, []);

  // After sign-in: consent first, then the daily greeting once a day, then home.
  const enter = useCallback(async () => {
    const t = await reload();
    if (!t) { go('signin'); return; }
    if (t.profile.role === 'hr') { go('hr'); return; }
    if (t.profile.role === 'chairman') { go('chair'); return; }
    if (t.profile.role === 'tech') { go('tech'); return; }
    if (ADMIN_ROLES.includes(t.profile.role)) { go('admin'); return; }
    if (!t.profile.consented) { go('consent'); return; }
    // location + camera prompt once per phone (iPhone Safari and the home-screen app count separately)
    if (!permsDone()) {
      if ((await permState('geolocation')) === 'granted' && (await permState('camera')) === 'granted') permsDone(true);
      else { go('perms'); return; }
    }
    go(firstViewToday('greeted') ? 'welcome' : 'home');
  }, [go, reload]);

  useEffect(() => {
    const t = setTimeout(async () => { (await api.session()) ? enter() : go('signin'); }, 1200);
    const off = api.onAuth((signedIn) => { if (signedIn) enter(); else { setToday(null); go('signin'); } });
    return () => { clearTimeout(t); off(); };
  }, [enter, go]);

  // Send any offline check-ins when the phone is back online
  useEffect(() => {
    // also every minute and when the app comes back to the front, so a save that timed out on a weak network goes through
    let busy = false;
    const flush = async () => {
      if (busy || !navigator.onLine || !(await api.session())) return;
      busy = true;
      try { const n = await api.flushQueue(); if (n) { toast(`${n} saved check-in${n > 1 ? 's' : ''} sent`); reload(); } } finally { busy = false; }
    };
    const vis = () => { if (document.visibilityState === 'visible') flush(); };
    addEventListener('online', flush); document.addEventListener('visibilitychange', vis);
    const t = setInterval(flush, 60000);
    flush();
    return () => { removeEventListener('online', flush); document.removeEventListener('visibilitychange', vis); clearInterval(t); };
  }, [toast, reload]);

  const ctx: Ctx = { screen, go, back, toast, email, setEmail, today, reload, camMode, setCamMode, result, setResult, odPrefill, setOdPrefill, leaveOd, setLeaveOd };
  const view = {
    splash: <Splash />, signin: <SignIn />, code: <Code />, consent: <Consent />, perms: <Permissions />, welcome: <Welcome />,
    home: <Home />, camera: <Camera />, result: <Result />, od: <ODForm />, leave: <LeaveForm />,
    notifs: <Notifications />, admin: <AdminSoon />, hr: <HRApp />, chair: <ChairApp />, tech: <TechApp />
  }[screen];

  return (
    <AppCtx.Provider value={ctx}>
      <div className="screen">
        {view}
        {DEMO && (screen === 'signin' || screen === 'home' || screen === 'hr' || screen === 'chair' || screen === 'tech') && (
          <div style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top,0px) + 4px)', left: 0, right: 0, textAlign: 'center', fontSize: 11, color: 'var(--ph-ink3)', zIndex: 60, pointerEvents: 'none' }}>Demo mode · sample data</div>
        )}
        {toastMsg && <div className="toast" role="status"><Icon n="check" />{toastMsg}</div>}
      </div>
    </AppCtx.Provider>
  );
}
