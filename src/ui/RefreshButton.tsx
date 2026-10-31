import { useState } from 'react';
import { hardRefresh } from '../device';
import { Icon } from './Icon';

/** Header button on every app's home: gets the latest data and app version. */
export function RefreshButton() {
  const [spin, setSpin] = useState(false);
  return (
    <button className={`rbtn ${spin ? 'spinning' : ''}`} aria-label="Refresh" title="Refresh" onClick={() => { setSpin(true); void hardRefresh(); }}>
      <Icon n="refresh" />
    </button>
  );
}
