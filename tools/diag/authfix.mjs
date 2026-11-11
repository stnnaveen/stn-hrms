// One-off (11 Nov): sign-in emails now go through Gmail (noreplyhr@startuptn.in). Raise Supabase's email limit
// from 30 to 150 an hour (rollout day: ~90 staff, retries), then send one test sign-in code and print what Auth answers.
const { REF, SUPABASE_ACCESS_TOKEN, SUPA_URL, ANON } = process.env;
const H = { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const url = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
const before = await (await fetch(url, { headers: H })).json();
console.log(`AF before rate_limit_email_sent=${before.rate_limit_email_sent} smtp=${before.smtp_host}`);
const r = await fetch(url, { method: 'PATCH', headers: H, body: JSON.stringify({ rate_limit_email_sent: 150 }) });
console.log(`AF patch ${r.status} ${r.ok ? '' : (await r.text()).slice(0, 200)}`);
const after = await (await fetch(url, { headers: H })).json();
console.log(`AF after rate_limit_email_sent=${after.rate_limit_email_sent}`);
const t = await fetch(`${SUPA_URL}/auth/v1/otp`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ai@startuptn.in', create_user: true }) });
console.log(`AF test ai… ${t.status} ${(await t.text()).slice(0, 200)}`);
