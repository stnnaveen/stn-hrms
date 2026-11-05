// One-off fix (5 Nov): eSSL 047 "Stalin Jacob J" was matched to STN069 Suman D by mistake.
// Match 047 -> STN047 Stalin Jacob J and 069 -> STN069 Suman D, only if names and codes still line up.
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const get = async (q) => (await fetch(`${SUPA_URL}/rest/v1/${q}`, { headers: h })).json();
for (const [code, emp, want] of [['047', 'STN047', 'stalin'], ['069', 'STN069', 'suman']]) {
  const [r] = await get(`staff_roster?select=email,full_name&employee_code=eq.${emp}`);
  const [p] = await get(`bio_people?select=link_id,essl_name,email&device_code=eq.${code}`);
  if (!r || !p || !r.full_name.toLowerCase().includes(want) || !(p.essl_name ?? '').toLowerCase().includes(want)) { console.log(`FIX skip ${code}: ${JSON.stringify({ r, p })}`); continue; }
  const res = await fetch(`${SUPA_URL}/rest/v1/bio_people?link_id=eq.${p.link_id}&device_code=eq.${code}`, { method: 'PATCH', headers: h, body: JSON.stringify({ email: r.email, matched: 'manual', updated_at: new Date().toISOString() }) });
  console.log(`FIX ${code} ${p.essl_name} -> ${emp} ${r.full_name}: HTTP ${res.status}`);
}
