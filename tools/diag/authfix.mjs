// One-off (9 Nov security hardening): tighten Supabase Auth settings. Changes only the fields below and prints before / after.
// Sign-in codes expire in 10 minutes (was 1 hour); minimum password length 8 (only the test logins use a fixed code;
// staff sign in with emailed codes); the future app address hrapp.startuptn.in is allowed for sign-in links.
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const H = { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const url = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
const KEYS = ['mailer_otp_exp', 'password_min_length', 'uri_allow_list', 'site_url', 'rate_limit_verify', 'rate_limit_otp'];
const show = (tag, a) => { for (const k of KEYS) console.log(`AF ${tag} ${k} = ${JSON.stringify(a?.[k])}`); };
const before = await (await fetch(url, { headers: H })).json();
show('before', before);
const allow = new Set(String(before.uri_allow_list ?? '').split(',').map((x) => x.trim()).filter(Boolean));
for (const u of ['https://stn-hrms.vercel.app', 'https://hrapp.startuptn.in']) allow.add(u);
const r = await fetch(url, { method: 'PATCH', headers: H, body: JSON.stringify({ mailer_otp_exp: 600, password_min_length: Math.max(8, Number(before.password_min_length ?? 0)), uri_allow_list: [...allow].join(',') }) });
console.log(`AF patch ${r.status}`);
show('after', await (await fetch(url, { headers: H })).json());
