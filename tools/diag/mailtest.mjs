// One-off (11 Nov): send one sign-in code exactly as the app does, and print what Auth answers (no secrets printed).
const { SUPA_URL, ANON } = process.env;
for (const email of ['ai@startuptn.in']) {
  const r = await fetch(`${SUPA_URL}/auth/v1/otp`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: true }) });
  console.log(`MAIL ${email.slice(0, 3)}… ${r.status} ${(await r.text()).slice(0, 300)}`);
}
