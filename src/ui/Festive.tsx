import { useEffect, useState } from 'react';

// Diwali week (1–8 Nov 2026, IST): a slim greeting banner, sky crackers in the home card for the first 3 seconds,
// and a small cracker burst on the check-in button.
// Turns itself off after 8 Nov. Light by design: inline SVG, transform/opacity animations only, nothing loaded,
// no layout shift, never blocks a tap, and still for anyone who prefers reduced motion.

const START = Date.parse('2026-11-01T00:00:00+05:30');
const END = Date.parse('2026-11-08T23:59:59+05:30');
export const diwaliOn = () => { const t = Date.now(); return t >= START && t <= END; };

const still = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** Slim banner: a diya with a soft flame, a thin half-mandala and a few slow sparkles. */
export function DiwaliBanner({ name }: { name: string }) {
  if (!diwaliOn()) return null;
  return (
    <div className="dwl" role="note" aria-label={`Happy Diwali Week, ${name}`}>
      <svg className="dwl-art" viewBox="0 0 120 64" aria-hidden="true">
        <defs>
          <radialGradient id="dwlFlame" cx="50%" cy="70%" r="60%"><stop offset="0" stopColor="#FFF6C8" /><stop offset=".55" stopColor="#FFC24A" /><stop offset="1" stopColor="#FF7A1A" stopOpacity="0" /></radialGradient>
          <linearGradient id="dwlBowl" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#E0563B" /><stop offset="1" stopColor="#8E2433" /></linearGradient>
        </defs>
        {/* thin half-mandala behind the lamp */}
        <g className="dwl-mandala" fill="none" stroke="#E9C77B" strokeWidth=".6" opacity=".55">
          {Array.from({ length: 13 }, (_, i) => { const a = Math.PI + (i * Math.PI) / 12; const x = 60 + Math.cos(a) * 26, y = 50 + Math.sin(a) * 26;
            return <path key={i} d={`M60 50 Q ${60 + Math.cos(a - 0.12) * 18} ${50 + Math.sin(a - 0.12) * 18} ${x} ${y} Q ${60 + Math.cos(a + 0.12) * 18} ${50 + Math.sin(a + 0.12) * 18} 60 50`} />; })}
          <path d="M28 50 A32 32 0 0 1 92 50" strokeDasharray="1 3" />
        </g>
        {/* diya */}
        <g className="dwl-glow"><ellipse cx="60" cy="38" rx="9" ry="12" fill="url(#dwlFlame)" opacity=".7" /></g>
        <path className="dwl-flame" d="M60 30 C 63 35 63.5 39 60 42 C 56.5 39 57 35 60 30 Z" fill="#FFD25E" />
        <path d="M60 34.5 C 61.3 37 61.4 39 60 40.6 C 58.6 39 58.7 37 60 34.5 Z" fill="#FFF8DC" />
        <path d="M46 44 Q 60 41 74 44 Q 72 54 60 55 Q 48 54 46 44 Z" fill="url(#dwlBowl)" />
        <path d="M46 44 Q 60 47 74 44" fill="none" stroke="#F3B26B" strokeWidth=".8" />
        <g fill="#F7D79A" opacity=".8"><circle cx="54" cy="49.5" r=".9" /><circle cx="60" cy="50.5" r=".9" /><circle cx="66" cy="49.5" r=".9" /></g>
        {/* slow sparkles */}
        <g fill="#FFE7A8">{[[18, 14, 0], [104, 10, 1.2], [96, 40, 2.1], [12, 44, 0.7], [84, 22, 1.7]].map(([x, y, d]) => <circle key={`${x}`} className="dwl-spark" cx={x} cy={y} r="1" style={{ animationDelay: `${d}s` }} />)}</g>
      </svg>
      <div className="dwl-t"><b>Happy Diwali Week, {name}!</b><span>Wishing you light and joy – StartupTN</span></div>
    </div>
  );
}

/** Sky crackers: three thin rockets rise and burst behind the home card's greeting, once per app open, gone after 3 s. */
let skyPlayed = false;
const SKY = [
  { x: 30, y: 30, d: 0, c: ['#FFD25E', '#FFF3C4'] },
  { x: 64, y: 22, d: 0.75, c: ['#FF5C8A', '#FFB4C8'] },
  { x: 80, y: 66, d: 1.5, c: ['#B57BFF', '#FFE7A8'] }
];
export function SkyCrackers() {
  const [show, setShow] = useState(() => { if (skyPlayed || !diwaliOn() || still()) return false; skyPlayed = true; return true; });
  useEffect(() => { if (!show) return; const t = setTimeout(() => setShow(false), 3200); return () => clearTimeout(t); }, [show]);
  if (!show) return null;
  return (
    <div className="sky" aria-hidden="true">
      {SKY.map((b, k) => (
        <div key={k} className="sky-b" style={{ left: `${b.x}%`, top: `${b.y}px`, ['--d' as string]: `${b.d}s`, ['--h' as string]: `${104 - b.y}px` }}>
          <span className="sky-rk" />
          {Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2, r = 18 + (i % 3) * 5;
            return <i key={i} style={{ ['--x' as string]: `${(Math.cos(a) * r).toFixed(1)}px`, ['--y' as string]: `${(Math.sin(a) * r).toFixed(1)}px`, background: b.c[i % 2] }} />; })}
        </div>))}
    </div>
  );
}

/** Small cracker burst at the button, drawn on the screen layer so it keeps playing while the camera opens. */
export function crackers(from: Element | null) {
  if (!from || !diwaliOn() || still()) return;
  const screen = document.querySelector('.screen'); if (!screen) return;
  const r = from.getBoundingClientRect(), s = screen.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'dwl-burst'; box.setAttribute('aria-hidden', 'true');
  box.style.left = `${r.left - s.left + r.width / 2}px`; box.style.top = `${r.top - s.top + r.height / 2}px`;
  const colors = ['#FFD25E', '#FF8A3D', '#FF5C8A', '#FFF3C4', '#B57BFF'];
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('i');
    const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3, d = 38 + Math.random() * 26;
    p.style.setProperty('--x', `${Math.cos(a) * d}px`); p.style.setProperty('--y', `${Math.sin(a) * d}px`);
    p.style.background = colors[i % colors.length]; p.style.animationDelay = `${Math.random() * 60}ms`;
    box.appendChild(p);
  }
  screen.appendChild(box);
  setTimeout(() => box.remove(), 1000);
}
