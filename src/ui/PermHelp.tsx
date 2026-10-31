import { isHomeScreenApp, phoneKind } from '../device';
import { Icon } from './Icon';

/** Step-by-step fix when location or camera is blocked. iPhone often blocks without asking when
 *  Location Services or "Safari Websites" is set to Never, so we show exactly where to switch it on. */
export function PermHelp({ what }: { what: Array<'location' | 'camera'> }) {
  const k = phoneKind(), app = isHomeScreenApp();
  const loc = what.includes('location'), cam = what.includes('camera');
  let steps: string[];
  if (k === 'iphone') {
    steps = [
      ...(loc ? ['Open Settings → Privacy & Security → Location Services. Turn it On.', 'In the same list, tap Safari Websites → While Using the App. Turn on Precise Location.'] : []),
      ...(cam ? ['Open Settings → Apps → Safari → Camera → Allow.'] : []),
      ...(app ? ['Close StartupTN HR fully (swipe it away), then open it again.'] : ['In Safari, tap aA in the address bar → Website Settings → set Location and Camera to Allow.']),
      'Tap Try again, then Allow.'
    ];
  } else if (k === 'android') {
    steps = [
      ...(loc ? ['Swipe down from the top and turn Location on.'] : []),
      `In Chrome, tap ⋮ → Settings → Site settings → ${loc && cam ? 'Location and Camera' : loc ? 'Location' : 'Camera'} → allow this site.`,
      ...(app ? ['Or long-press the StartupTN HR icon → App info → Permissions → Allow.'] : []),
      'Come back and tap Try again.'
    ];
  } else {
    steps = ['Click the lock icon next to the web address.', `Set ${loc && cam ? 'Location and Camera' : loc ? 'Location' : 'Camera'} to Allow.`, 'Reload the page and try again.'];
  }
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="row"><span className="ri c-warn"><Icon n="alert" /></span><span className="t"><b>{loc && cam ? 'Location and camera are off' : loc ? 'Location is off' : 'Camera is off'}</b><span>{k === 'iphone' ? 'iPhone' : k === 'android' ? 'Android' : 'This browser'} · fix in a minute</span></span></div>
      <ol className="steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
    </div>
  );
}
