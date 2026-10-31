// Edge function: check-in and check-out.
//   POST { action: 'start', ... }    -> device binding + signed S3 upload URL for the selfie
//   POST { action: 'complete', ... } -> rules, face match, place name, punch, flags, attendance day
//   POST { action: 'health' }   -> Tech admin: which services are on (no secrets)
//   POST { action: 'resolve_venue', url } -> OD form: Google/Apple Maps link -> pin, name, place
//   kind 'visit' = OD venue check-in during an approved OD; never changes the day's check-in or check-out
// The reply to the phone never contains distance, radius, inside/outside, flags or face score.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from 'npm:@aws-sdk/client-s3@3.654.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.654.0';
import { RekognitionClient, CompareFacesCommand } from 'npm:@aws-sdk/client-rekognition@3.654.0';
import { evaluate, istMinutes, radiusCheck, type Settings, type PrevPunch } from '../_shared/rules.ts';
import { firstUrl, isMapsHost, coordsFrom, coordsFromHtml, nameFrom } from '../_shared/maplink.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
const REGION = env('AWS_REGION') || 'ap-south-1';
const BUCKET = env('S3_SELFIE_BUCKET');
const aws = { region: REGION, credentials: { accessKeyId: env('AWS_ACCESS_KEY_ID'), secretAccessKey: env('AWS_SECRET_ACCESS_KEY') } };
const s3 = new S3Client(aws);
// Until StartupTN's AWS keys are set, selfies go to private Supabase Storage and face match is skipped.
const USE_S3 = !!(BUCKET && env('AWS_ACCESS_KEY_ID') && env('AWS_SECRET_ACCESS_KEY'));
const rek = new RekognitionClient(aws);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

interface Body {
  action: 'start' | 'complete' | 'health' | 'resolve_venue' | 'radius_test' | 'purge';
  kind: 'in' | 'out' | 'visit';
  url?: string;
  // radius_test (Tech): a point to test against a hub, or against a pin + radius
  hub_id?: string; point?: { lat: number; lng: number; accuracy: number | null }; target?: { lat: number; lng: number; radius_m: number };
  // purge (Tech, testing phase)
  scope?: string; user?: string | null; hub?: string | null; from?: string | null; to?: string | null; what?: string[]; dry?: boolean;
  idempotency_key: string;
  device_key: string;
  platform?: string;
  selfie_key?: string;
  client_time?: string;
  location?: { lat: number; lng: number; accuracy: number | null; altitude?: number | null; speed?: number | null; mocked?: boolean | null };
  liveness?: { challenge: string; passed: boolean };
}

const istDay = (d: Date) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: 'not_signed_in' }, 401);
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  // ---- health: which services are switched on (names only, never keys). Tech admin only.
  if (body.action === 'health') {
    const { data: me } = await db.from('profiles').select('role, active').eq('id', user.id).single();
    if (me?.role !== 'tech' || !me.active) return json({ error: 'not_allowed' }, 403);
    const t0 = Date.now(); const { error } = await db.from('settings').select('key').limit(1);
    return json({ ok: true, db_ms: Date.now() - t0, db_ok: !error, storage: USE_S3 ? 's3' : 'supabase', face_match: USE_S3, geocode: env('GOOGLE_GEOCODING_KEY') ? 'google' : 'osm', region: REGION });
  }
  // ---- Tech admin tools: radius test (same decision as check-in) and clearing test records
  if (body.action === 'radius_test' || body.action === 'purge') {
    const { data: me } = await db.from('profiles').select('role, active').eq('id', user.id).single();
    if (me?.role !== 'tech' || !me.active) return json({ error: 'not_allowed' }, 403);
    if (body.action === 'radius_test') {
      const pt = body.point;
      if (!pt || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lng)) return json({ error: 'bad_request' }, 400);
      let t = body.target ? { lat: body.target.lat, lng: body.target.lng, radiusM: body.target.radius_m } : null;
      if (!t && body.hub_id) { const { data: h } = await db.from('hubs').select('lat, lng, radius_m').eq('id', body.hub_id).single(); if (h) t = { lat: h.lat, lng: h.lng, radiusM: h.radius_m }; }
      if (!t) return json({ error: 'no_target' }, 400);
      const r = radiusCheck(pt, t);
      return json({ ok: true, distance_m: Math.round(r.distanceM), credit_m: Math.round(r.creditM), inside: r.inside, radius_m: t.radiusM, place: await placeFor(db, pt.lat, pt.lng) });
    }
    const { data: res, error } = await asUser.rpc('purge_records', { p_scope: body.scope, p_user: body.user ?? null, p_hub: body.hub ?? null,
      p_from: body.from ?? null, p_to: body.to ?? null, p_what: body.what ?? ['checkins', 'flags', 'od', 'leave', 'notifications'], p_dry: body.dry !== false });
    if (error) return json({ error: (error.message || 'purge_failed').replace(/^.*?:\s*/, '') }, 400);
    let photos = 0;
    const keys: string[] = res?.selfie_keys ?? [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      if (USE_S3) { try { await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: chunk.map((Key) => ({ Key })) } })); photos += chunk.length; } catch { /* keep going */ } }
      const { data: gone } = await db.storage.from('selfies').remove(chunk.map((k) => k.replace(/^selfies\//, '')));
      if (!USE_S3) photos += gone?.length ?? 0;
    }
    return json({ ok: true, ...res, selfie_keys: undefined, photos_removed: photos });
  }

  // ---- OD venue: read a Google or Apple Maps link on the server (short links need redirects the phone can't follow)
  if (body.action === 'resolve_venue') {
    const r = await resolveVenue(db, String(body.url ?? ''));
    return 'error' in r ? json(r, 422) : json(r);
  }
  if (!['in', 'out', 'visit'].includes(body.kind) || !body.idempotency_key || !body.device_key) return json({ error: 'bad_request' }, 400);

  const { data: profile } = await db.from('profiles').select('id, full_name, hub_id, active, consent_at, face_status, reference_photo_key').eq('id', user.id).single();
  if (!profile?.active) return json({ error: 'not_active' }, 403);
  if (!profile.consent_at) return json({ error: 'consent_needed' }, 403);

  // ---- phone binding: first phone is bound; any other waits for the Tech admin (PRD LC-06)
  const { data: devices } = await db.from('devices').select('id, device_key, status').eq('user_id', user.id);
  let device = devices?.find((d) => d.device_key === body.device_key);
  if (!device) {
    const first = !devices?.some((d) => d.status === 'active');
    const { data: created } = await db.from('devices').insert({
      user_id: user.id, device_key: body.device_key, platform: body.platform ?? 'web',
      user_agent: req.headers.get('user-agent'), status: first ? 'active' : 'pending'
    }).select('id, device_key, status').single();
    device = created!;
    if (!first) {
      await db.rpc('notify_role', { p_role: 'tech', p_kind: 'device_new', p_title: 'New phone request', p_body: profile.full_name, p_data: { device_id: device.id } });
    }
  }
  if (device.status !== 'active') return json({ error: device.status === 'pending' ? 'device_pending' : 'device_revoked' }, 403);

  // ---- start: signed upload URL
  if (body.action === 'start') {
    const key = `selfies/${user.id}/${istDay(new Date())}/${body.idempotency_key}.jpg`;
    if (!USE_S3) {
      const path = key.slice('selfies/'.length);
      const { data, error } = await db.storage.from('selfies').createSignedUploadUrl(path);
      if (error || !data) return json({ error: 'upload_unavailable' }, 500);
      return json({ store: 'supabase', upload_path: path, upload_token: data.token, selfie_key: key });
    }
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'image/jpeg' }), { expiresIn: 120 });
    return json({ store: 's3', upload_url: url, selfie_key: key });
  }

  // ---- complete
  if (body.action !== 'complete' || !body.location || !body.selfie_key || !body.client_time) return json({ error: 'bad_request' }, 400);
  if (!body.selfie_key.startsWith(`selfies/${user.id}/`)) return json({ error: 'bad_selfie_key' }, 400);

  const { data: existing } = await db.from('punches').select('server_time, kind, band, early_out, place_name, lat, lng').eq('idempotency_key', body.idempotency_key).maybeSingle();
  if (existing) return json(reply(existing));

  const now = new Date();
  const today = istDay(now);
  const { data: day } = await db.from('attendance_days').select('in_time, out_time').eq('user_id', user.id).eq('day', today).maybeSingle();
  if (body.kind === 'in' && day?.in_time) return json({ error: 'already_checked_in' }, 409);
  if (body.kind === 'out' && !day?.in_time) return json({ error: 'not_checked_in' }, 409);
  if (body.kind === 'out' && day?.out_time) return json({ error: 'already_checked_out' }, 409);
  if (body.kind === 'visit' && !day?.in_time) return json({ error: 'check_in_first' }, 409);

  const settings = await loadSettings(db);

  // target: an approved OD covering now (from 30 min before) beats the hub (PRD LC-04)
  const { data: od } = await db.from('od_requests').select('id, venue_lat, venue_lng, venue_radius_m')
    .eq('user_id', user.id).eq('status', 'approved')
    .lte('starts_at', new Date(now.getTime() + 30 * 60000).toISOString()).gte('ends_at', now.toISOString())
    .not('venue_lat', 'is', null).limit(1).maybeSingle();
  if (body.kind === 'visit') {
    if (!od) return json({ error: 'no_od_now' }, 409);
    const { data: done } = await db.from('punches').select('id').eq('user_id', user.id).eq('target_type', 'od').eq('target_id', od.id).limit(1).maybeSingle();
    if (done) return json({ error: 'already_visited' }, 409);
  }
  let target: { type: 'hub' | 'od'; id: string; lat: number; lng: number; radiusM: number };
  if (od) target = { type: 'od', id: od.id, lat: od.venue_lat, lng: od.venue_lng, radiusM: od.venue_radius_m };
  else {
    const { data: hub } = await db.from('hubs').select('id, lat, lng, radius_m').eq('id', profile.hub_id).single();
    if (!hub) return json({ error: 'no_hub' }, 409);
    target = { type: 'hub', id: hub.id, lat: hub.lat, lng: hub.lng, radiusM: hub.radius_m };
  }

  const { data: history } = await db.from('punches').select('kind, lat, lng, accuracy_m, server_time')
    .eq('user_id', user.id).order('server_time', { ascending: false }).limit(20);
  const toPrev = (p: { lat: number; lng: number; accuracy_m: number | null; server_time: string }): PrevPunch =>
    ({ lat: p.lat, lng: p.lng, accuracy: p.accuracy_m, at: new Date(p.server_time) });
  const seen = new Set<string>([today]);
  const recentDays: PrevPunch[] = [];
  for (const p of history ?? []) {
    const d = istDay(new Date(p.server_time));
    if (p.kind === 'in' && !seen.has(d)) { seen.add(d); recentDays.push(toPrev(p)); }
  }
  const lastPunch = history?.[0] ? toPrev(history[0]) : null;

  // face match 1:1 against the approved reference photo (PRD FM-05); keep the score only
  let faceSimilarity: number | null = null;
  let faceError: string | null = null;
  if (USE_S3 && profile.face_status === 'approved' && profile.reference_photo_key) {
    try {
      const r = await rek.send(new CompareFacesCommand({
        SourceImage: { S3Object: { Bucket: BUCKET, Name: profile.reference_photo_key } },
        TargetImage: { S3Object: { Bucket: BUCKET, Name: body.selfie_key } },
        SimilarityThreshold: 0
      }));
      faceSimilarity = Math.max(0, ...(r.FaceMatches ?? []).map((m) => m.Similarity ?? 0));
    } catch (e) { faceError = String(e).slice(0, 200); }
  }

  const loc = body.location;
  const ev = evaluate({
    kind: body.kind, serverTime: now, clientTime: new Date(body.client_time),
    fix: { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, altitude: loc.altitude, speed: loc.speed, mocked: loc.mocked },
    target, faceSimilarity, liveness: body.liveness ?? null, recentDays, lastPunch,
    integrityOk: null, settings
  });

  const placeName = await placeFor(db, loc.lat, loc.lng);

  const { data: punch, error } = await db.from('punches').insert({
    user_id: user.id, kind: body.kind, status: ev.status, device_id: device.id, idempotency_key: body.idempotency_key,
    client_time: body.client_time, server_time: now.toISOString(),
    synced_late_minutes: Math.max(0, Math.round((now.getTime() - new Date(body.client_time).getTime()) / 60000)),
    lat: loc.lat, lng: loc.lng, accuracy_m: loc.accuracy, altitude: loc.altitude ?? null, speed: loc.speed ?? null, mocked: loc.mocked ?? null,
    place_name: placeName, target_type: target.type, target_id: target.id, distance_m: Math.round(ev.distanceM), inside: ev.inside,
    selfie_key: body.selfie_key, face_similarity: faceSimilarity,
    liveness: { ...(body.liveness ?? {}), face_error: faceError }, quality_score: ev.quality, band: ev.band, early_out: ev.earlyOut
  }).select('id, server_time, kind, band, early_out, place_name, lat, lng').single();
  if (error || !punch) return json({ error: 'save_failed' }, 500);

  if (ev.flags.length) {
    await db.from('flags').insert(ev.flags.map((f) => ({ punch_id: punch.id, user_id: user.id, kind: f.kind, rule: f.rule, details: f.details })));
  }

  if (body.kind === 'visit') {
    // venue proof only; the day's check-in and check-out stay as they are
  } else if (body.kind === 'in') {
    await db.from('attendance_days').insert({ user_id: user.id, day: today, in_punch: punch.id, in_time: now.toISOString(), band: ev.band, status: target.type === 'od' ? 'od' : 'present' });
  } else {
    await db.from('attendance_days').update({ out_punch: punch.id, out_time: now.toISOString(), early_out: ev.earlyOut }).eq('user_id', user.id).eq('day', today);
  }

  return json(reply(punch));
});

// What the phone is allowed to know
function reply(p: { server_time: string; kind: string; band: string | null; early_out: boolean; place_name: string | null; lat: number; lng: number }) {
  return { ok: true, kind: p.kind, server_time: p.server_time, band: p.band, early_out: p.early_out, place_name: p.place_name, lat: p.lat, lng: p.lng, ist_minutes: istMinutes(new Date(p.server_time)) };
}

// deno-lint-ignore no-explicit-any
async function loadSettings(db: any): Promise<Settings> {
  const { data } = await db.from('settings').select('key, value');
  const m = Object.fromEntries((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  return {
    officeStart: m.office_start ?? '10:00', lateUntil: m.late_until ?? '10:15', officeEnd: m.office_end ?? '18:00',
    faceThreshold: Number(m.face_threshold ?? 80), samePointDays: Number(m.same_point_days ?? 5),
    offlineFlagMinutes: Number(m.offline_flag_minutes ?? 30), clockGapMinutes: Number(m.clock_gap_minutes ?? 2), jumpKmh: Number(m.jump_kmh ?? 150)
  };
}

// OD venue from a Google or Apple Maps link. Follows short-link redirects only through Maps hosts (no open fetches).
// deno-lint-ignore no-explicit-any
async function resolveVenue(db: any, text: string): Promise<{ lat: number; lng: number; name: string | null; place: string | null; url: string } | { error: string }> {
  const start = firstUrl(text.trim());
  if (!start || !isMapsHost(start)) return { error: 'not_maps_link' };
  const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'Accept-Language': 'en' };
  let url = start, name = nameFrom(url), c = coordsFrom(url);
  try {
    for (let hop = 0; !c && hop < 6; hop++) {
      const r = await fetch(url, { redirect: 'manual', headers: UA, signal: AbortSignal.timeout(5000) });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        const next = new URL(loc, url).toString();
        if (!isMapsHost(next) && !/^https:\/\/(consent\.google\.com|www\.google\.com\/sorry)/.test(next)) return { error: 'not_maps_link' };
        if (/consent\.google\.com/.test(next)) { const cont = new URL(next).searchParams.get('continue'); if (cont && isMapsHost(cont)) { url = cont; } else break; }
        else url = next;
        name = nameFrom(url) ?? name; c = coordsFrom(url);
        continue;
      }
      if (r.ok) { const html = (await r.text()).slice(0, 400000); c = coordsFromHtml(html); }
      else await r.body?.cancel();
      break;
    }
  } catch { /* fall through to the name search */ }
  if (!c && name) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(name)}`,
        { headers: { 'User-Agent': 'StartupTN-HR/1.0 (attendance app)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (j?.[0]) c = { lat: Number(j[0].lat), lng: Number(j[0].lon) };
    } catch { /* no luck */ }
  }
  if (!c) return { error: 'no_pin' };
  return { lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)), name, place: await placeFor(db, c.lat, c.lng), url: start };
}

// Reverse geocode, cached by coordinates rounded to 4 decimals (~11 m) (PRD LC-09)
// deno-lint-ignore no-explicit-any
async function placeFor(db: any, lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const { data: hit } = await db.from('geo_cache').select('place_name').eq('key', key).maybeSingle();
  if (hit) return hit.place_name;
  let name: string | null = null;
  const gkey = env('GOOGLE_GEOCODING_KEY');
  if (gkey) {
    // Google: the same names people see in Google Maps
    try {
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${gkey}`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      const comps = j.results?.[0]?.address_components ?? [];
      const pick = (t: string) => comps.find((c: { types: string[] }) => c.types.includes(t))?.long_name;
      name = [pick('route'), pick('sublocality_level_1') ?? pick('sublocality') ?? pick('neighborhood'), pick('locality')].filter(Boolean).join(', ') || j.results?.[0]?.formatted_address || null;
    } catch { /* fall back */ }
  }
  if (!name) {
    // Free: OpenStreetMap (Nominatim), then Photon if Nominatim refuses cloud servers
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`,
        { headers: { 'User-Agent': 'StartupTN-HR/1.0 (hr.startuptn.in; attendance app)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(5000) });
      if (r.ok) name = osmLabel(await r.json());
    } catch { /* next */ }
  }
  if (!name) {
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=en`, { headers: { 'User-Agent': 'StartupTN-HR/1.0' }, signal: AbortSignal.timeout(5000) });
      if (r.ok) name = photonLabel(await r.json());
    } catch { /* give up: the app shows coordinates and map links */ }
  }
  if (name) await db.from('geo_cache').insert({ key, place_name: name });
  return name;
}

// deno-lint-ignore no-explicit-any
function photonLabel(j: any): string | null {
  const p = j?.features?.[0]?.properties ?? {};
  const parts = [p.street ?? p.name, p.district ?? p.locality, p.city ?? p.county].filter((x: unknown, i: number, a: unknown[]) => x && a.indexOf(x) === i);
  return parts.length ? parts.join(', ') : null;
}

// "Ashok Pillar Road, Ashok Nagar, Chennai" style label from an OpenStreetMap reverse lookup
// deno-lint-ignore no-explicit-any
export function osmLabel(j: any): string | null {
  const a = j?.address ?? {};
  // road first, not the nearest named building: a building name can match a different branch elsewhere in the city
  const parts = [
    a.road || a.pedestrian || a.footway || j?.name,
    a.neighbourhood || a.suburb || a.quarter || a.village || a.hamlet,
    a.city || a.town || a.municipality || a.county || a.state_district
  ].filter((x: unknown, i: number, arr: unknown[]) => x && arr.indexOf(x) === i);
  return parts.length ? parts.join(', ') : (j?.display_name ?? null);
}
