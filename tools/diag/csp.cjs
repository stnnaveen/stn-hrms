// Diagnostic (read only): open the LIVE app as the test logins (staff, HR, Chairman), visit every tab, open a person
// (maps) and the check-in camera (face model), and report anything the Content-Security-Policy blocks or would block.
// Nothing is saved: the camera is opened and closed without a check-in.
const { chromium } = require('playwright');
const APP = process.env.APP_URL || 'https://stn-hrms.vercel.app';
(async () => {
  const { SUPA_URL, SERVICE, ANON, REF } = process.env;
  const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const session = async (email) => {
    const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email }) })).json();
    return (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
  };
  const head = await fetch(APP, { method: 'GET' });
  for (const h of ['content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'])
    console.log(`CSP header ${h}: ${head.headers.has(h) ? 'set' : 'missing'}`);
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  let total = 0;
  for (const [who, email] of [['staff', 'naveenflop+staff@gmail.com'], ['hr', 'hr.ai@startuptn.in'], ['chairman', 'chairman.ai@startuptn.in']]) {
    const s = await session(email);
    if (!s.access_token) { console.log(`CSP ${who}: no session`); continue; }
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera', 'geolocation'], geolocation: { latitude: 13.0108, longitude: 80.2206 } });
    await c.addInitScript(([k, v]) => {
      try { localStorage.setItem(k, v); } catch {}
      document.addEventListener('securitypolicyviolation', (e) => console.log(`CSPV ${e.disposition} ${e.effectiveDirective} ${String(e.blockedURI).slice(0, 120)}`));
    }, [`sb-${REF}-auth-token`, JSON.stringify(s)]);
    const p = await c.newPage();
    const seen = new Set();
    p.on('console', (m) => { const t = m.text(); if (/^CSPV|Content Security Policy|Refused to/.test(t) && !seen.has(t)) { seen.add(t); total++; console.log(`CSP ${who} ${t.slice(0, 220)}`); } });
    p.on('pageerror', (e) => console.log(`CSP ${who} pageerror ${e.message.slice(0, 160)}`));
    await p.goto(APP); await p.waitForTimeout(6000);
    const tabs = await p.locator('nav.tabs button').allInnerTexts().catch(() => []);
    console.log(`CSP ${who} tabs: ${tabs.map((t) => t.trim()).join(' | ')}`);
    for (let i = 0; i < tabs.length; i++) { await p.locator('nav.tabs button').nth(i).click().catch(() => {}); await p.waitForTimeout(2500); }
    if (who !== 'staff') {   // a person page has maps
      await p.locator('nav.tabs button').nth(1).click().catch(() => {}); await p.waitForTimeout(2500);
      await p.locator('.row, .person, li').filter({ hasText: /Chennai|Coimbatore|Madurai/ }).first().click().catch(() => {}); await p.waitForTimeout(5000);
    } else {                  // the check-in camera loads the face model; close it without saving
      await p.locator('nav.tabs button').first().click().catch(() => {}); await p.waitForTimeout(1500);
      const btn = p.getByRole('button', { name: /^(Check in|Check out)$/ }).first();
      if (await btn.count()) { await btn.click().catch(() => {}); await p.waitForTimeout(12000); console.log(`CSP staff camera opened · video ${await p.locator('video').count()}`); }
      else console.log('CSP staff no check-in button now');
    }
    if (who !== 'staff') {   // live tracking screens (11 Nov): open from Home, report what they show
      const shot = async (tag) => { const b64 = (await p.screenshot()).toString('base64'); for (let i = 0; i < b64.length; i += 8000) console.log(`IMG ${who}-${tag} ${b64.slice(i, i + 8000)}`); };
      await p.goto(APP); await p.waitForTimeout(6000); await shot('home');
      for (const name of ['Live map', 'Out of office']) {
        const btn = p.locator('button.setrow', { hasText: name }).first();
        if (!(await btn.count())) { console.log(`CSP ${who} no '${name}' row`); continue; }
        await btn.click(); await p.waitForTimeout(6000);
        console.log(`CSP ${who} ${name}: ${(await p.locator('.scr').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`);
        await shot(name === 'Live map' ? 'live' : 'out');
        await p.goto(APP); await p.waitForTimeout(5000);
      }
    }
    console.log(`CSP ${who} done`);
    await c.close();
  }
  console.log(`CSP total messages ${total}`);
  await b.close();
})();
