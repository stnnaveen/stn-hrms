// bio-sync: the eSSL sync program on the office PC posts new fingerprint punches here every 30 seconds.
// Auth: header x-bio-key (a link key made by the Tech admin; only its SHA-256 hash is stored). No user session,
// so this function runs with verify_jwt = false and checks the key itself. Nothing here decides attendance
// (rule 1): punches are stored as evidence and shown to HR.
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

const MAX_BODY = 2_000_000;
const MAX_PUNCHES = 1000;
const linkCache = new Map<string, { id: string; at: number }>();

async function sha256(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function linkFor(key: string): Promise<string | null> {
  if (!/^stnbio_[0-9a-f]{64}$/.test(key)) return null;
  const hit = linkCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;          // revoking takes effect within a minute
  const { data } = await db.from('bio_links').select('id').eq('key_hash', await sha256(key)).is('revoked_at', null).maybeSingle();
  if (!data) { linkCache.delete(key); return null; }
  linkCache.set(key, { id: data.id, at: Date.now() });
  return data.id;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const link = await linkFor((req.headers.get('x-bio-key') ?? '').trim());
  if (!link) return json({ error: 'bad_key' }, 401);

  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) return json({ error: 'too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    body = JSON.parse(text);
  } catch { return json({ error: 'bad_json' }, 400); }

  const punches = Array.isArray(body.punches) ? body.punches : [];
  if (punches.length > MAX_PUNCHES) return json({ error: 'too_many', max: MAX_PUNCHES }, 413);
  const payload = {
    agent: typeof body.agent === 'object' && body.agent ? body.agent : {},
    devices: Array.isArray(body.devices) ? body.devices.slice(0, 200) : undefined,
    people: Array.isArray(body.people) ? body.people.slice(0, 5000) : undefined,
    punches,
    // eSSL's own numbers (sync v1.1+): row counts per day and eTimeTrackLite's in/out per person per day
    audit: typeof body.audit === 'object' && body.audit ? {
      tables: Array.isArray((body.audit as Record<string, unknown>).tables) ? ((body.audit as Record<string, unknown>).tables as unknown[]).slice(0, 24) : undefined,
      attendance: Array.isArray((body.audit as Record<string, unknown>).attendance) ? ((body.audit as Record<string, unknown>).attendance as unknown[]).slice(0, 20000) : undefined
    } : undefined
  };
  const t0 = Date.now();
  const { data, error } = await db.rpc('bio_ingest', { p_link: link, p: payload });
  if (error) {
    console.log(JSON.stringify({ bio_sync_error: error.message, link, punches: punches.length }));
    return json({ error: 'save_failed' }, 500);
  }
  return json({ ...data, ms: Date.now() - t0, server_time: new Date().toISOString() });
});
