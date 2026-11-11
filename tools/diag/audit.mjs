// Security audit (read only): Supabase Auth settings (safe fields only, no secrets), Supabase security advisor,
// and database facts: functions anyone signed-out could call, tables without RLS, definer functions without a fixed search_path.
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const H = { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const api = (p, o = {}) => fetch(`https://api.supabase.com/v1/projects/${REF}${p}`, { headers: H, ...o }).then(async (r) => [r.status, await r.json().catch(() => null)]);
const SAFE = ['site_url', 'uri_allow_list', 'disable_signup', 'external_email_enabled', 'external_google_enabled', 'external_phone_enabled', 'external_anonymous_users_enabled',
  'mailer_otp_exp', 'mailer_otp_length', 'mailer_autoconfirm', 'password_min_length', 'password_required_characters', 'password_hibp_enabled', 'jwt_exp',
  'refresh_token_rotation_enabled', 'security_refresh_token_reuse_interval', 'sessions_timebox', 'sessions_inactivity_timeout', 'security_captcha_enabled',
  'rate_limit_email_sent', 'rate_limit_otp', 'rate_limit_verify', 'rate_limit_token_refresh', 'rate_limit_anonymous_users', 'rate_limit_sms_sent',
  'mfa_totp_enroll_enabled', 'mfa_max_enrolled_factors', 'security_manual_linking_enabled', 'smtp_host', 'smtp_admin_email'];
const [as, a] = await api('/config/auth');
console.log(`AUD auth ${as}`); if (a) for (const k of SAFE) if (k in a) console.log(`AUD auth ${k} = ${JSON.stringify(a[k])}`);
const [vs, v] = await api('/advisors/security');
console.log(`AUD advisor ${vs}`);
for (const x of (v?.lints ?? [])) console.log(`AUD advisor ${x.level} ${x.name} · ${(x.detail ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
const sql = async (q) => { const [s, j] = await api('/database/query', { method: 'POST', body: JSON.stringify({ query: q, read_only: true }) }); return s < 300 ? j : [{ error: s, j: JSON.stringify(j).slice(0, 200) }]; };
const q = {
  anon_functions: `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`,
  no_rls: `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
  anon_tables: `select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`,
  definer_no_path: `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
  views: `select c.relname, coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'false') as invoker from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v'`,
  admins: `select r.role, count(*) as n, string_agg(split_part(r.email, '@', 2), ',') as domains from staff_roster r where r.role in ('hr', 'chairman', 'tech') group by 1`,
  admin_profiles: `select role, active, count(*) from profiles where role in ('hr','chairman','tech') group by 1, 2`,
  admin_allow: `select r.role, r.email in ('hr.ai@startuptn.in','ai@startuptn.in','chairman.ai@startuptn.in','chairmanoffice@startuptn.in','hr@startuptn.in') as allowed, left(r.email, 3) || '…@' || split_part(r.email, '@', 2) as who, coalesce(p.active, false) as signed_up_active from staff_roster r left join profiles p on p.email = r.email where r.role in ('hr', 'chairman', 'tech') order by 1, 3`,
  custom_admins: `select count(*) from profiles where custom_role_id is not null`,
  buckets: `select id, public from storage.buckets`,
  extensions: `select extname, extversion from pg_extension order by 1`
};
for (const [k, qq] of Object.entries(q)) console.log(`AUD db ${k}: ${JSON.stringify(await sql(qq)).slice(0, 700)}`);
const [ss, sec] = await api('/secrets');
console.log(`AUD secrets ${ss}: ${(Array.isArray(sec) ? sec.map((x) => x.name).sort() : []).join(', ')}`);   // names only, never values
// ---- sign-in email (SMTP / Resend): settings without the password, then recent auth errors about mail (emails masked)
console.log(`AUD mail smtp_host=${a?.smtp_host} port=${a?.smtp_port} user=${a?.smtp_user} sender=${a?.smtp_sender_name} admin=${a?.smtp_admin_email} pass_set=${!!a?.smtp_pass} max_freq=${a?.smtp_max_frequency} rate_email=${a?.rate_limit_email_sent} external_email=${a?.external_email_enabled}`);
{
  const end = new Date(), start = new Date(Date.now() - 24 * 3600e3);
  let j = {}, r = { status: 0 };
  for (const [ep, q] of [['logs', "select timestamp, event_message, response.status_code from edge_logs cross join unnest(metadata) as m cross join unnest(m.request) as request cross join unnest(m.response) as response where request.path like '%/auth/v1/otp%' order by timestamp desc limit 40"],
                         ['logs', "select timestamp, event_message, metadata from auth_logs order by timestamp desc limit 30"]]) {
    const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/${ep}?sql=${encodeURIComponent(q)}&iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}`;
    r = await fetch(u, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } }); j = await r.json().catch(() => ({}));
    console.log(`AUD maillog ${ep} ${r.status} ${j.error ? JSON.stringify(j.error).slice(0, 200) : ''} rows ${(j.result ?? []).length}`);
    for (const x of (j.result ?? [])) console.log('AUD maillog', new Date(Number(x.timestamp) / 1000).toISOString().slice(0, 19), x.status_code ?? '', String(x.event_message).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, (m) => m.slice(0, 3) + '…@' + m.split('@')[1]).replace(/\s+/g, ' ').slice(0, 330));
  }
  j = {};
  for (const x of (j.result ?? [])) console.log('AUD maillog', new Date(Number(x.timestamp) / 1000).toISOString().slice(0, 19), x.status_code ?? '', String(x.event_message).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, (m) => m.slice(0, 3) + '…@' + m.split('@')[1]).replace(/\s+/g, ' ').slice(0, 330));
}
