import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../App';
import { openExternal } from '../device';
import { Icon } from './Icon';

const FALLBACK = { email: 'ai@startuptn.in', whatsapp: '', phone: '' };

/** Help on every staff screen: selfie or location trouble goes straight to the AI team (WhatsApp, call or email).
 *  The contact is set by the Tech admin. Nothing about checks is sent; only name, code and hub. */
export function HelpButton({ look = 'icon' }: { look?: 'icon' | 'bar' | 'button' }) {
  const { today } = useApp();
  const [open, setOpen] = useState(false);
  const c = today?.help && (today.help.email || today.help.whatsapp || today.help.phone) ? today.help : FALLBACK;
  const p = today?.profile;
  const who = p ? `${p.full_name}${p.employee_code ? ` (${p.employee_code})` : ''}${p.hub ? `, ${p.hub} hub` : ''}` : '';
  const msg = `Hi AI team, I need help with StartupTN HR check-in.${who ? ` ${who}.` : ''}`;
  const digits = (n: string) => n.replace(/[^0-9]/g, '');
  const host = document.querySelector('.screen');
  const btn = look === 'icon'
    ? <button className="rbtn" onClick={() => setOpen(true)} aria-label="Help"><Icon n="help" /></button>
    : look === 'bar'
      ? <button className="x" onClick={() => setOpen(true)} aria-label="Help"><Icon n="help" /></button>
      : <button className="btn light" onClick={() => setOpen(true)}><Icon n="help" />Get help</button>;
  return (
    <>
      {btn}
      {open && host && createPortal(<>
        <div className="scrim" onClick={() => setOpen(false)} />
        <div className="sheet" role="dialog" aria-label="Help"><div className="grab" />
          <h3>Need help?</h3><p>Selfie or location trouble? The AI team fixes it fast.</p>
          <div className="opts">
            {c.whatsapp && <button className="opt" onClick={() => openExternal(`https://wa.me/${digits(c.whatsapp)}?text=${encodeURIComponent(msg)}`)}>
              <div className="ri c-ok"><Icon n="chat" /></div><div><b>WhatsApp</b><span>{c.whatsapp}</span></div><Icon n="chevR" className="c" /></button>}
            {c.phone && <button className="opt" onClick={() => openExternal(`tel:${c.phone.startsWith('+') ? '+' : ''}${digits(c.phone)}`)}>
              <div className="ri c-od"><Icon n="phone" /></div><div><b>Call</b><span>{c.phone}</span></div><Icon n="chevR" className="c" /></button>}
            {c.email && <button className="opt" onClick={() => openExternal(`mailto:${c.email}?subject=${encodeURIComponent('StartupTN HR help')}&body=${encodeURIComponent(msg)}`)}>
              <div className="ri c-pend"><Icon n="mail" /></div><div><b>Email</b><span>{c.email}</span></div><Icon n="chevR" className="c" /></button>}
          </div>
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setOpen(false)}>Close</button>
        </div>
      </>, host)}
    </>
  );
}
