// Diagnostic: open the real HR app (local build on live data) signed in as the HR test login, open a staff profile, report the selfie tiles.
const { chromium } = require('playwright');
(async () => {
  const { SUPA_URL, SERVICE, ANON, REF, WHO = 'Naveen Kumar S' } = process.env;
  const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email: 'naveenflop@gmail.com' }) })).json();
  const s = await (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
  const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await c.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [`sb-${REF}-auth-token`, JSON.stringify(s)]);
  const p = await c.newPage();
  p.on('console', (m) => console.log('BR console', m.type(), m.text().slice(0, 200)));
  p.on('pageerror', (e) => console.log('BR pageerror', e.message.slice(0, 200)));
  p.on('requestfailed', (r) => console.log('BR failed', r.url().slice(0, 120), r.failure()?.errorText));
  p.on('response', async (r) => { if (/functions\/v1\/check-in/.test(r.url())) { let body = ''; try { body = (await r.text()).slice(0, 160).replace(/https:[^"]+/g, '<url>'); } catch {} console.log('BR fn', r.status(), r.request().postData()?.slice(0, 80), body); } if (/storage\/v1\/object\/sign/.test(r.url())) console.log('BR img', r.status()); });
  await p.goto('http://localhost:4173/'); await p.waitForTimeout(6000);
  await p.screenshot({ path: 'br1.png' });
  await p.getByRole('button', { name: /Staff/ }).last().click().catch((e) => console.log('BR no staff tab', e.message.slice(0, 80)));
  await p.waitForTimeout(3000);
  await p.getByText(WHO, { exact: true }).first().click().catch((e) => console.log('BR no person', e.message.slice(0, 80)));
  await p.waitForTimeout(6000);
  await p.screenshot({ path: 'br2.png', fullPage: false });
  const tiles = await p.locator('.ph').evaluateAll((els) => els.map((e) => ({ img: !!e.querySelector('img'), src: e.querySelector('img')?.getAttribute('src')?.slice(0, 50) ?? null, ok: e.querySelector('img')?.naturalWidth ?? null, text: e.textContent.slice(0, 40) })));
  console.log('BR tiles', JSON.stringify(tiles));
  await b.close();
})();
