// Edge function: check-in and check-out.
//   POST { action: 'start', ... }    -> device binding + signed S3 upload URL for the selfie
//   POST { action: 'complete', ... } -> rules, face match, place name, punch, flags, attendance day
//   POST { action: 'health' }   -> Tech admin: which services are on (no secrets)
//   POST { action: 'selfie_urls', keys } -> HR / Chairman / Tech: short-lived links to view selfies (S3 or Supabase Storage)
//   POST { action: 'resolve_venue', url } -> OD form: Google/Apple Maps link -> pin, name, place
//   kind 'visit' = OD venue check-in during an approved OD; never changes the day's check-in or check-out
// The reply to the phone never contains distance, radius, inside/outside, flags or face score.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { makeAws } from '../_shared/aws.ts';
import { evaluate, istMinutes, radiusCheck, type Settings, type PrevPunch } from '../_shared/rules.ts';
import { firstUrl, isMapsHost, isMapsRedirect, coordsFrom, coordsFromHtml, nameFrom, coordsFromText, plusCodeIn, decodePlusCode } from '../_shared/maplink.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
// one Google key (Places API (New) + Geocoding API enabled) under either name
const gkeyOf = () => env('GOOGLE_MAPS_KEY') || env('GOOGLE_GEOCODING_KEY');
const REGION = env('AWS_REGION') || 'ap-south-1';
const BUCKET = env('S3_SELFIE_BUCKET');
const aws = makeAws({ region: REGION, bucket: BUCKET, accessKeyId: env('AWS_ACCESS_KEY_ID'), secretAccessKey: env('AWS_SECRET_ACCESS_KEY') });
// Until StartupTN's AWS keys are set, selfies go to private Supabase Storage and face match is skipped.
// S3_ON=1 turns it on once the AWS path is proven (5 Nov: the AWS SDK ran out of compute on first use, so it stays off until fixed)
const USE_S3 = !!(BUCKET && env('AWS_ACCESS_KEY_ID') && env('AWS_SECRET_ACCESS_KEY')) && env('S3_ON') === '1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-presence-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

interface Body {
  action: 'start' | 'complete' | 'punch' | 'ping' | 'timing' | 'presence' | 'presence_token' | 'reset_test_day' | 'health' | 'selfie_urls' | 'resolve_venue' | 'radius_test' | 'purge' | 'delete_person' | 'remove_selfie';
  timings?: Record<string, number>; total_ms?: number; keys?: string[]; leave_for_od?: string | null; test_s3?: boolean;
  // our own shape, or the background-location SDK's record shape (coords, timestamp, is_moving, event, provider)
  samples?: Record<string, unknown>[];
  kind: 'in' | 'out' | 'visit';
  url?: string;
  // radius_test (Tech): a point to test against a hub, or against a pin + radius
  hub_id?: string; point?: { lat: number; lng: number; accuracy: number | null }; target?: { lat: number; lng: number; radius_m: number };
  // purge (Tech, testing phase)
  email?: string; punch_id?: string; reason?: string;
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

  const T0 = Date.now();
  // one-shot check-in sends the selfie and the details together (multipart); everything else is JSON
  let body: Body;
  let selfie: Blob | null = null;
  try {
    if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const fd = await req.formData();
      body = JSON.parse(String(fd.get('data') ?? '{}'));
      const f = fd.get('selfie');
      selfie = f instanceof Blob ? f : null;
      body.action = 'punch';
    } else body = await req.json();
  } catch { return json({ error: 'bad_json' }, 400); }
  // warm-up when the camera opens, so the real save doesn't wait for a cold start
  if (body.action === 'ping') return json({ ok: true });

  // ---- store app, background: the location SDK posts with a long-lived phone token (no app session needed)
  if (body.action === 'presence' && req.headers.get('x-presence-token')) {
    const uid = await verifyPresenceToken(req.headers.get('x-presence-token')!);
    if (!uid) return json({ error: 'not_signed_in' }, 401);
    return json(await presence(createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY')), uid, body.samples ?? []));
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: 'not_signed_in' }, 401);
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
  const tAuth = Date.now() - T0;

  // ---- test staff (test mode on): clear today's check-ins to try again
  if (body.action === 'reset_test_day') {
    const { data: res, error } = await asUser.rpc('reset_my_test_day');
    if (error) return json({ error: (error.message || 'reset_failed').replace(/^.*?:\s*/, '') }, 400);
    await removeSelfies(db, res?.selfie_keys ?? []);
    return json({ ok: true });
  }

  // ---- the phone reports how long the whole save took; very slow saves are reported to Tech
  if (body.action === 'timing') {
    const total = Math.round(Number(body.total_ms ?? 0));
    if (!body.idempotency_key || !Number.isFinite(total)) return json({ error: 'bad_request' }, 400);
    const { data: pu } = await db.from('punches').select('id, timings, kind').eq('idempotency_key', body.idempotency_key).eq('user_id', user.id).maybeSingle();
    if (pu) {
      await db.from('punches').update({ timings: { ...(pu.timings ?? {}), total_ms: total } }).eq('id', pu.id);
      if (total > 60000) {
        const { data: me } = await db.from('profiles').select('full_name').eq('id', user.id).single();
        await db.rpc('notify_role', { p_role: 'tech', p_kind: 'slow_checkin', p_title: 'Slow check-in', p_body: `${me?.full_name ?? 'Staff'} · ${Math.round(total / 1000)} s to save`, p_data: { punch_id: pu.id } });
      }
    }
    return json({ ok: true });
  }
  // ---- health: which services are switched on (names only, never keys). Tech admin only.
  if (body.action === 'health') {
    const { data: me } = await db.from('profiles').select('role, active').eq('id', user.id).single();
    if (me?.role !== 'tech' || !me.active) return json({ error: 'not_allowed' }, 403);
    const t0 = Date.now(); const { error } = await db.from('settings').select('key').limit(1);
    const dbMs = Date.now() - t0;
    // with AWS keys set, prove the bucket really accepts a write and a delete (names the error, never the keys)
    let s3Ok: boolean | null = null, s3Err: string | null = null;
    if (USE_S3 || (BUCKET && body.test_s3)) {
      try {
        const k = `selfies/_health/${crypto.randomUUID()}.txt`;
        await aws.put(k, 'ok', 'text/plain');
        // the private view link must open the file (proves link signing), then the file is removed
        const got = await fetch(await aws.presign(k, 'GET', 60));
        if (!got.ok || (await got.text()) !== 'ok') throw Object.assign(new Error('view link'), { name: `ViewLink${got.status}` });
        await aws.del(k);
        s3Ok = true;
      } catch (e) { s3Ok = false; s3Err = (body.test_s3 ? String((e as Error).message ?? e) : (e as { name?: string }).name ?? 'S3Error').slice(0, 400); }
    }
    return json({ ok: true, db_ms: dbMs, db_ok: !error, s3_ok: s3Ok, s3_error: s3Err, bucket: USE_S3 ? BUCKET : null, storage: USE_S3 ? 's3' : 'supabase', face_match: USE_S3, geocode: gkeyOf() ? 'google' : env('OLA_MAPS_KEY') ? 'ola' : 'osm', region: REGION });
  }
  // ---- HR / Chairman / Tech: short-lived links (5 min) to view selfies, wherever each file lives
  if (body.action === 'selfie_urls') {
    const keys = [...new Set((body.keys ?? []).filter((k) => typeof k === 'string' && k.startsWith('selfies/')))].slice(0, 100);
    const [{ data: me }, { data: rows }] = await Promise.all([
      db.from('profiles').select('role, active').eq('id', user.id).single(),
      keys.length ? db.from('punches').select('selfie_key, selfie_store').in('selfie_key', keys) : Promise.resolve({ data: [] })
    ]);
    if (!me?.active || !['hr', 'chairman', 'tech'].includes(me.role)) return json({ error: 'not_allowed' }, 403);
    const store = new Map((rows ?? []).map((r: { selfie_key: string; selfie_store: string | null }) => [r.selfie_key, r.selfie_store ?? 'supabase']));
    const urls: Record<string, string | null> = {};
    const s3Keys = keys.filter((k) => store.get(k) === 's3' && USE_S3), sbKeys = keys.filter((k) => !s3Keys.includes(k));
    await Promise.all([
      // Supabase photos: one call signs them all
      sbKeys.length ? db.storage.from('selfies').createSignedUrls(sbKeys.map((k) => k.slice('selfies/'.length)), 300).then(({ data }: { data: { path: string | null; signedUrl: string | null }[] | null }) => {
        for (const k of sbKeys) urls[k] = data?.find((d) => d.path === k.slice('selfies/'.length))?.signedUrl ?? null;
      }).catch(() => { for (const k of sbKeys) urls[k] = null; }) : null,
      ...s3Keys.map(async (k) => { try { urls[k] = await aws.presign(k, 'GET', 300); } catch { urls[k] = null; } })
    ]);
    return json({ ok: true, urls });
  }

  // ---- HR/Tech: delete a person completely; Tech: remove one selfie. The database decides who may; photos go here.
  if (body.action === 'delete_person' || body.action === 'remove_selfie') {
    if (body.action === 'delete_person') {
      const { data: res, error } = await asUser.rpc('delete_staff_full', { p_email: String(body.email ?? '') });
      if (error) return json({ error: (error.message || 'delete_failed').replace(/^.*?:\s*/, '') }, 400);
      const photos = await removeSelfies(db, res?.selfie_keys ?? []);
      return json({ ok: true, ...res, selfie_keys: undefined, photos_removed: photos });
    }
    const { data: key, error } = await asUser.rpc('remove_selfie', { p_punch: String(body.punch_id ?? ''), p_reason: String(body.reason ?? '') });
    if (error) return json({ error: (error.message || 'remove_failed').replace(/^.*?:\s*/, '') }, 400);
    return json({ ok: true, photos_removed: await removeSelfies(db, [key]) });
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
    const photos = await removeSelfies(db, res?.selfie_keys ?? []);
    return json({ ok: true, ...res, selfie_keys: undefined, photos_removed: photos });
  }

  // ---- store app: work-hours location samples sent in the background. The server decides inside/outside;
  //      the reply says nothing about it (rule 2).
  if (body.action === 'presence') return json(await presence(db, user.id, body.samples ?? []));
  // the phone's background-location token: 30 days, renewed whenever the app opens
  if (body.action === 'presence_token') return json({ token: await signPresenceToken(user.id), expires_in: 30 * 86400 });

  // ---- OD venue: read a Google or Apple Maps link on the server (short links need redirects the phone can't follow)
  if (body.action === 'resolve_venue') {
    const r = await resolveVenue(db, String(body.url ?? ''));
    return 'error' in r ? json(r, 422) : json(r);
  }
  if (!['in', 'out', 'visit'].includes(body.kind) || !body.idempotency_key || !body.device_key) return json({ error: 'bad_request' }, 400);
  if (String(body.idempotency_key).length > 80 || String(body.device_key).length > 100) return json({ error: 'bad_request' }, 400);

  const [{ data: profile }, { data: devices }] = await Promise.all([
    db.from('profiles').select('id, full_name, hub_id, active, consent_at, face_status, reference_photo_key').eq('id', user.id).single(),
    db.from('devices').select('id, device_key, status').eq('user_id', user.id)
  ]);
  if (!profile?.active) return json({ error: 'not_active' }, 403);
  if (!profile.consent_at) return json({ error: 'consent_needed' }, 403);

  // ---- phone binding: first phone is bound; any other waits for the Tech admin (PRD LC-06)
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
    const url = await aws.presign(key, 'PUT', 120);
    return json({ store: 's3', upload_url: url, selfie_key: key });
  }

  // ---- punch (one request: selfie + details) or complete (after a separate upload; used by offline-queued saves)
  if (body.action === 'punch') {
    // a real JPEG from the camera (starts with FF D8 FF), within the storage limit
    if (!selfie || selfie.size < 1000 || selfie.size > 3_000_000) return json({ error: 'bad_selfie' }, 400);
    const head = new Uint8Array(await selfie.slice(0, 3).arrayBuffer());
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return json({ error: 'bad_selfie' }, 400);
    body.selfie_key = `selfies/${user.id}/${istDay(new Date())}/${body.idempotency_key}.jpg`;
  } else if (body.action !== 'complete') return json({ error: 'bad_request' }, 400);
  if (!body.location || !body.selfie_key || !body.client_time) return json({ error: 'bad_request' }, 400);
  {
    const l = body.location, ct = Date.parse(body.client_time);
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!num(l.lat) || !num(l.lng) || Math.abs(l.lat) > 90 || Math.abs(l.lng) > 180) return json({ error: 'bad_location' }, 400);
    if (l.accuracy != null && (!num(l.accuracy) || l.accuracy < 0)) return json({ error: 'bad_location' }, 400);
    if (!Number.isFinite(ct) || ct > Date.now() + 24 * 3600e3 || ct < Date.now() - 7 * 24 * 3600e3) return json({ error: 'bad_time' }, 400);
  }
  if (!body.selfie_key.startsWith(`selfies/${user.id}/`)) return json({ error: 'bad_selfie_key' }, 400);

  const now = new Date();
  const today = istDay(now);
  // everything this save needs, fetched at the same time
  const [{ data: existing }, { data: dayRow }, settings, { data: od }, { data: hubRow }, { data: history }, { data: testMode }, { data: leaveOd }] = await Promise.all([
    db.from('punches').select('server_time, kind, band, early_out, place_name, lat, lng').eq('idempotency_key', body.idempotency_key).maybeSingle(),
    db.from('attendance_days').select('in_time, out_time').eq('user_id', user.id).eq('day', today).maybeSingle(),
    loadSettings(db),
    // target: an approved OD covering now (from 30 min before) beats the hub (PRD LC-04)
    db.from('od_requests').select('id, venue_lat, venue_lng, venue_radius_m')
      .eq('user_id', user.id).eq('status', 'approved')
      .lte('starts_at', new Date(now.getTime() + 30 * 60000).toISOString()).gte('ends_at', now.toISOString())
      .not('venue_lat', 'is', null).limit(1).maybeSingle(),
    profile.hub_id ? db.from('hubs').select('id, lat, lng, radius_m').eq('id', profile.hub_id).single() : Promise.resolve({ data: null }),
    db.from('punches').select('kind, lat, lng, accuracy_m, server_time').eq('user_id', user.id).order('server_time', { ascending: false }).limit(20),
    db.rpc('is_test_mode', { p_uid: user.id }),
    // check-out to go to one of today's ODs (approved or waiting): not an early leave
    body.kind === 'out' && body.leave_for_od
      ? db.from('od_requests').select('id').eq('id', body.leave_for_od).eq('user_id', user.id).in('status', ['approved', 'pending'])
          .lt('starts_at', new Date(`${today}T23:59:59+05:30`).toISOString()).gt('ends_at', now.toISOString()).maybeSingle()
      : Promise.resolve({ data: null })
  ]);
  if (existing) return json(reply(existing));
  let day = dayRow as { in_time: string | null; out_time: string | null } | null;
  // test staff: a new check-in clears today's earlier ones, and check-out can be repeated
  if (testMode === true && body.kind === 'in' && day?.in_time) {
    const { data: res } = await asUser.rpc('reset_my_test_day');
    await removeSelfies(db, res?.selfie_keys ?? []);
    day = null;
  }
  // the selfie upload starts now and runs while the rules are checked
  const tUp0 = Date.now();
  const uploadP: Promise<boolean> = body.action !== 'punch' ? Promise.resolve(true) : (async () => {
    const key = body.selfie_key!;
    if (USE_S3) {
      try { await aws.put(key, new Uint8Array(await selfie!.arrayBuffer()), 'image/jpeg'); return true; } catch { return false; }
    }
    const { error } = await db.storage.from('selfies').upload(key.slice('selfies/'.length), selfie!, { contentType: 'image/jpeg', upsert: true });
    return !error;
  })();
  let uploadMs = 0;
  uploadP.then(() => { uploadMs = Date.now() - tUp0; });
  if (body.kind === 'in' && day?.in_time) return json({ error: 'already_checked_in' }, 409);
  if (body.kind === 'out' && !day?.in_time) return json({ error: 'not_checked_in' }, 409);
  if (body.kind === 'out' && day?.out_time && testMode !== true) return json({ error: 'already_checked_out' }, 409);
  if (body.kind === 'visit' && !day?.in_time) return json({ error: 'check_in_first' }, 409);

  if (body.kind === 'visit') {
    if (!od) return json({ error: 'no_od_now' }, 409);
    const { data: done } = await db.from('punches').select('id').eq('user_id', user.id).eq('target_type', 'od').eq('target_id', od.id).limit(1).maybeSingle();
    if (done) return json({ error: 'already_visited' }, 409);
  }
  let target: { type: 'hub' | 'od'; id: string; lat: number; lng: number; radiusM: number };
  if (od) target = { type: 'od', id: od.id, lat: od.venue_lat, lng: od.venue_lng, radiusM: od.venue_radius_m };
  else {
    const hub = hubRow as { id: string; lat: number; lng: number; radius_m: number } | null;
    if (!hub) return json({ error: 'no_hub' }, 409);
    target = { type: 'hub', id: hub.id, lat: hub.lat, lng: hub.lng, radiusM: hub.radius_m };
  }
  const toPrev = (p: { lat: number; lng: number; accuracy_m: number | null; server_time: string }): PrevPunch =>
    ({ lat: p.lat, lng: p.lng, accuracy: p.accuracy_m, at: new Date(p.server_time) });
  const seen = new Set<string>([today]);
  const recentDays: PrevPunch[] = [];
  for (const p of history ?? []) {
    const d = istDay(new Date(p.server_time));
    if (p.kind === 'in' && !seen.has(d)) { seen.add(d); recentDays.push(toPrev(p)); }
  }
  const lastPunch = history?.[0] ? toPrev(history[0]) : null;

  // the photo must be stored before the face check and before the punch points at it
  if (!(await uploadP)) return json({ error: 'upload_failed' }, 502);

  // face match 1:1 against the approved reference photo (PRD FM-05); keep the score only
  let faceSimilarity: number | null = null;
  let faceError: string | null = null;
  if (USE_S3 && profile.face_status === 'approved' && profile.reference_photo_key) {
    try {
      faceSimilarity = await aws.compareFaces(profile.reference_photo_key, body.selfie_key);
    } catch (e) { faceError = String(e).slice(0, 200); }
  }

  const loc = body.location;
  const ev = evaluate({
    kind: body.kind, serverTime: now, clientTime: new Date(body.client_time),
    fix: { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, altitude: loc.altitude, speed: loc.speed, mocked: loc.mocked },
    target, faceSimilarity, liveness: body.liveness ?? null, recentDays, lastPunch,
    integrityOk: null, settings, odLeave: !!leaveOd
  });

  // place name: instant from the cache; otherwise filled in right after the reply so the save never waits on a map service
  const geoKey = `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
  const { data: cached } = await db.from('geo_cache').select('place_name').eq('key', geoKey).maybeSingle();
  const placeName: string | null = cached?.place_name ?? null;

  const { data: punch, error } = await db.from('punches').insert({
    user_id: user.id, kind: body.kind, status: ev.status, device_id: device.id, idempotency_key: body.idempotency_key,
    client_time: body.client_time, server_time: now.toISOString(),
    synced_late_minutes: Math.max(0, Math.round((now.getTime() - new Date(body.client_time).getTime()) / 60000)),
    lat: loc.lat, lng: loc.lng, accuracy_m: loc.accuracy, altitude: loc.altitude ?? null, speed: loc.speed ?? null, mocked: loc.mocked ?? null,
    place_name: placeName, target_type: target.type, target_id: target.id, distance_m: Math.round(ev.distanceM), inside: ev.inside,
    selfie_key: body.selfie_key, selfie_store: USE_S3 ? 's3' : 'supabase', face_similarity: faceSimilarity,
    liveness: { ...(body.liveness ?? {}), face_error: faceError }, quality_score: ev.quality, band: ev.band, early_out: ev.earlyOut,
    timings: { ...(body.timings ?? {}), auth_ms: tAuth, upload_ms: uploadMs, server_ms: Date.now() - T0, one_shot: body.action === 'punch' }
  }).select('id, server_time, kind, band, early_out, place_name, lat, lng').single();
  if (error || !punch) return json({ error: 'save_failed' }, 500);

  await Promise.all([
    ev.flags.length ? db.from('flags').insert(ev.flags.map((f) => ({ punch_id: punch.id, user_id: user.id, kind: f.kind, rule: f.rule, details: f.details }))) : Promise.resolve(),
    body.kind === 'visit' ? Promise.resolve()   // venue proof only; the day's check-in and check-out stay as they are
      : body.kind === 'in' ? db.from('attendance_days').insert({ user_id: user.id, day: today, in_punch: punch.id, in_time: now.toISOString(), band: ev.band, status: target.type === 'od' ? 'od' : 'present' })
      : db.from('attendance_days').update({ out_punch: punch.id, out_time: now.toISOString(), early_out: ev.earlyOut, leave_od_id: leaveOd?.id ?? null }).eq('user_id', user.id).eq('day', today)
  ]);

  if (!placeName) {
    const fill = placeFor(db, loc.lat, loc.lng).then((n) => (n ? db.from('punches').update({ place_name: n }).eq('id', punch.id) : null)).catch(() => null);
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(fill);
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

// Delete selfie files from S3 (when set up) and Supabase Storage. Returns how many were removed.
// deno-lint-ignore no-explicit-any
async function removeSelfies(db: any, keys: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100).filter(Boolean);
    if (!chunk.length) continue;
    if (USE_S3) n += await aws.delMany(chunk);
    const { data: gone } = await db.storage.from('selfies').remove(chunk.map((k) => k.replace(/^selfies\//, '')));
    if (!USE_S3) n += gone?.length ?? 0;
  }
  return n;
}

// Plus Code in a link or text. A short code ("244M+6JF") is completed from a reference point within ~50 km:
// the area written after it (Google → Photon → OpenStreetMap), else the nearest hub. Kept under ~8 s in total.
// deno-lint-ignore no-explicit-any
async function fromPlusCode(text: string, db: any): Promise<{ lat: number; lng: number } | null> {
  const p = plusCodeIn(text);
  if (!p) return null;
  if (p.full) return decodePlusCode(p.code);
  const deadline = Date.now() + 8000;
  const parts = p.area.split(',').map((x) => x.trim()).filter(Boolean);
  const pin = p.area.match(/\b\d{6}\b/)?.[0];
  const tries = [...new Set([parts.slice(-3).join(', '), pin ? `${pin}, India` : '', parts.slice(-2).join(', ')].filter(Boolean))];
  for (const q of tries) {
    if (Date.now() > deadline) break;
    const ref = await geocodeArea(q, deadline);
    if (ref) return decodePlusCode(p.code, ref);
  }
  // nearest hub: decode against each hub and keep the answer closest to its hub
  const { data: hubs } = await db.from('hubs').select('lat, lng');
  let best: { lat: number; lng: number } | null = null, bestD = Infinity;
  for (const h of hubs ?? []) {
    const c = decodePlusCode(p.code, h); if (!c) continue;
    const d = Math.hypot(c.lat - h.lat, (c.lng - h.lng) * Math.cos((h.lat * Math.PI) / 180));
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD < 0.5 ? best : null;
}
async function geocodeArea(q: string, deadline: number): Promise<{ lat: number; lng: number } | null> {
  const left = () => Math.max(500, Math.min(3000, deadline - Date.now()));
  const gkey = gkeyOf();
  if (gkey) {
    try {
      const j = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=in&key=${gkey}`, { signal: AbortSignal.timeout(left()) })).json();
      const l = j?.results?.[0]?.geometry?.location; if (l) return { lat: l.lat, lng: l.lng };
    } catch { /* next */ }
  }
  try {   // Photon (OpenStreetMap data, no key), biased to Tamil Nadu
    const j = await (await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&lat=11.1&lon=78.6`, { headers: { 'User-Agent': 'StartupTN-HR/1.0 (attendance app)' }, signal: AbortSignal.timeout(left()) })).json();
    const g = j?.features?.[0]?.geometry?.coordinates; if (g) return { lat: g[1], lng: g[0] };
  } catch { /* next */ }
  try {
    const j = await (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'StartupTN-HR/1.0 (attendance app)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(left()) })).json();
    if (j?.[0]) return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
  } catch { /* none */ }
  return null;
}

// Google Maps' own search (as a browser does) for the place text in a share link: the first result is the place itself.
async function googleMapSearch(text: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetch(`https://www.google.com/search?tbm=map&hl=en&gl=in&q=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en' } });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const m = (await r.text()).match(/\[null,null,(-?\d{1,2}\.\d{4,}),(-?\d{1,3}\.\d{4,})\]/);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? { lat, lng } : null;
  } catch { return null; }
}

// Places API (New) text search: Google finds the place it named in its own link. Needs GOOGLE_MAPS_KEY (or GOOGLE_GEOCODING_KEY).
async function googlePlace(text: string): Promise<{ lat: number; lng: number } | null> {
  const key = gkeyOf();
  if (!key) return null;
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.location' },
      body: JSON.stringify({ textQuery: text, regionCode: 'IN', pageSize: 1 }) });
    const l = (await r.json())?.places?.[0]?.location;
    return l ? { lat: l.latitude, lng: l.longitude } : null;
  } catch { return null; }
}

// Phone token for background location: base64url({u, e}).HMAC-SHA256, key derived from the service key (never leaves
// the server). Holds only the user id and expiry; every use re-checks the profile (active, consent) in presence().
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
let presenceKey: CryptoKey | null = null;
async function pkey() {
  if (presenceKey) return presenceKey;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('SUPABASE_SERVICE_ROLE_KEY')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', base, new TextEncoder().encode('stn-presence-v1')));
  presenceKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return presenceKey;
}
async function signPresenceToken(uid: string): Promise<string> {
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ u: uid, e: Math.floor(Date.now() / 1000) + 30 * 86400 })));
  return `${payload}.${b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await pkey(), new TextEncoder().encode(payload))))}`;
}
async function verifyPresenceToken(token: string): Promise<string | null> {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig || token.length > 400) return null;
    if (!(await crypto.subtle.verify('HMAC', await pkey(), unb64u(sig), new TextEncoder().encode(payload)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    return typeof p.u === 'string' && typeof p.e === 'number' && p.e > Date.now() / 1000 ? p.u : null;
  } catch { return null; }
}

// Work-hours presence: keep samples between check-in and check-out inside office hours, judge each against the hub
// (or the venue of an approved OD at that time), store them, and raise one 'away' dispute + tell HR when someone has
// been outside longer than the alert setting.
// deno-lint-ignore no-explicit-any
async function presence(db: any, uid: string, raw: Record<string, unknown>[]): Promise<{ ok: true; stored: number }> {
  const today = istDay(new Date());
  const [{ data: prof }, { data: day }, { data: cfg }] = await Promise.all([
    db.from('profiles').select('active, role, hub_id, presence_consent_at').eq('id', uid).single(),
    db.from('attendance_days').select('in_time, out_time, status').eq('user_id', uid).eq('day', today).maybeSingle(),
    db.from('settings').select('key, value').in('key', ['presence_enabled', 'presence_alert_minutes', 'office_start', 'office_end'])
  ]);
  const set = Object.fromEntries((cfg ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  if (!prof?.active || !prof.presence_consent_at || !['staff', 'intern'].includes(prof.role) || set.presence_enabled === false || !day?.in_time || day.status === 'leave') return { ok: true, stored: 0 };
  const hhmm = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const open = Date.parse(`${today}T${hhmm(set.office_start, '10:00')}:00+05:30`) - 15 * 60000;
  const close = Date.parse(`${today}T${hhmm(set.office_end, '18:00')}:00+05:30`) + 5 * 60000;
  const from = Math.max(open, Date.parse(day.in_time) - 5 * 60000), to = Math.min(close, day.out_time ? Date.parse(day.out_time) : Date.now() + 60000);
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  // accept our shape {lat,lng,accuracy,time,source} and the SDK's {coords:{latitude,…}, timestamp, is_moving, event, mock, provider}
  // deno-lint-ignore no-explicit-any
  const norm = (x: any) => {
    if (!x || typeof x !== 'object') return null;
    const c = x.coords ?? x;
    const lat = c.latitude ?? c.lat, lng = c.longitude ?? c.lng;
    const time = num(x.time) ? x.time : typeof x.timestamp === 'string' ? Date.parse(x.timestamp) : num(x.timestamp) ? x.timestamp : NaN;
    const off = x.event === 'providerchange' && x.provider && x.provider.enabled === false;
    return { lat, lng, accuracy: c.accuracy ?? null, time, source: off ? 'off' : x.source === 'beat' || x.extras?.beat ? 'beat' : 'watch',
      moving: typeof x.is_moving === 'boolean' ? x.is_moving : null, event: typeof x.event === 'string' ? x.event.slice(0, 30) : null, mock: x.mock === true ? true : null };
  };
  const samples = (Array.isArray(raw) ? raw : []).slice(0, 200).map(norm)
    .filter((x): x is NonNullable<ReturnType<typeof norm>> => !!x && num(x.lat) && num(x.lng) && Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180 && num(x.time) && x.time >= from && x.time <= to)
    .sort((a, b) => a.time - b.time);
  if (!samples.length) return { ok: true, stored: 0 };
  const [{ data: hub }, { data: ods }] = await Promise.all([
    prof.hub_id ? db.from('hubs').select('id, lat, lng, radius_m').eq('id', prof.hub_id).single() : Promise.resolve({ data: null }),
    db.from('od_requests').select('id, venue_lat, venue_lng, venue_radius_m, starts_at, ends_at').eq('user_id', uid).eq('status', 'approved')
      .lte('starts_at', new Date(samples[samples.length - 1].time + 30 * 60000).toISOString()).gte('ends_at', new Date(samples[0].time).toISOString()).not('venue_lat', 'is', null)
  ]);
  const rows = samples.map((x) => {
    const od = (ods ?? []).find((o: { starts_at: string; ends_at: string }) => x.time >= Date.parse(o.starts_at) - 30 * 60000 && x.time <= Date.parse(o.ends_at));
    const t = od ? { type: 'od', id: od.id, lat: od.venue_lat, lng: od.venue_lng, radiusM: od.venue_radius_m } : hub ? { type: 'hub', id: hub.id, lat: hub.lat, lng: hub.lng, radiusM: hub.radius_m } : null;
    const acc = num(x.accuracy) && (x.accuracy as number) >= 0 ? (x.accuracy as number) : null;
    const rc = t ? radiusCheck({ lat: x.lat, lng: x.lng, accuracy: acc }, t) : null;
    return { user_id: uid, at: new Date(x.time).toISOString(), source: x.source, moving: x.moving, event: x.event, mock: x.mock, lat: x.lat, lng: x.lng, accuracy_m: acc,
      target_type: t?.type ?? 'hub', target_id: t?.id ?? null, distance_m: rc ? Math.round(rc.distanceM) : null, inside: rc ? rc.inside : true, edge: rc ? rc.inside && rc.distanceM > t!.radiusM : false };
  });
  await db.from('presence_samples').insert(rows);

  // fake GPS (mock location app) reported by the phone: one dispute a day, HR told
  const fake = rows.find((r) => r.mock === true);
  if (fake) {
    const { data: seen } = await db.from('flags').select('id').eq('user_id', uid).eq('kind', 'mock_location').gte('created_at', `${today}T00:00:00+05:30`).limit(1).maybeSingle();
    if (!seen) {
      const { data: me } = await db.from('profiles').select('full_name').eq('id', uid).single();
      await db.from('flags').insert({ user_id: uid, kind: 'mock_location', rule: 'R-03 fake GPS app detected (store app, work hours)', details: { at: fake.at, lat: fake.lat, lng: fake.lng } });
      await db.rpc('notify_role', { p_role: 'hr', p_kind: 'mock_location', p_title: 'Fake GPS detected', p_body: me?.full_name ?? 'Staff', p_data: { user_id: uid } });
    }
  }

  // long time outside: from the first outside sample after the last inside one
  const last = rows[rows.length - 1];
  if (!last.inside && last.target_type === 'hub' && last.source !== 'off') {
    const { data: lastIn } = await db.from('presence_samples').select('at').eq('user_id', uid).eq('inside', true).gte('at', new Date(from).toISOString()).order('at', { ascending: false }).limit(1).maybeSingle();
    const { data: firstOut } = await db.from('presence_samples').select('at, distance_m').eq('user_id', uid).eq('inside', false)
      .gt('at', lastIn?.at ?? new Date(from).toISOString()).order('at').limit(1).maybeSingle();
    const alertMin = Number(set.presence_alert_minutes ?? 30);
    if (firstOut && Date.parse(last.at) - Date.parse(firstOut.at) >= alertMin * 60000) {
      const { data: already } = await db.from('flags').select('id').eq('user_id', uid).eq('kind', 'away').gte('created_at', firstOut.at).limit(1).maybeSingle();
      if (!already) {
        const mins = Math.round((Date.parse(last.at) - Date.parse(firstOut.at)) / 60000);
        const { data: me } = await db.from('profiles').select('full_name').eq('id', uid).single();
        await db.from('flags').insert({ user_id: uid, kind: 'away', rule: `R-12 outside the radius ${mins}+ min in work hours`, details: { since: firstOut.at, minutes: mins, distance_m: last.distance_m } });
        await db.rpc('notify_role', { p_role: 'hr', p_kind: 'away', p_title: 'Away from hub', p_body: `${me?.full_name ?? 'Staff'} · outside ${mins} min`, p_data: { user_id: uid } });
      }
    }
  }
  return { ok: true, stored: rows.length };
}

// Google Maps "share list" links ("/maps/@/data=…!7m…") point at a saved-places list, not one place
function isListLink(u: string): boolean { let d = u; try { d = decodeURIComponent(u); } catch { /* raw */ } return /\/maps\/@\/data=.*!7m/.test(d); }

// OD venue / hub pin from a Google or Apple Maps link. Follows short-link redirects only through Google/Apple pages (no open fetches).
// deno-lint-ignore no-explicit-any
async function resolveVenue(db: any, text: string): Promise<{ lat: number; lng: number; name: string | null; place: string | null; url: string; approx?: boolean } | { error: string }> {
  // typed coordinates ("13.00623, 80.25241" or 13°00'22.4"N 80°15'08.7"E) or a Plus Code ("244M+6JF Tharapakkam")
  if (!/https?:\/\//i.test(text)) {
    const typed = coordsFromText(text) ?? await fromPlusCode(text, db);
    if (typed) return { lat: typed.lat, lng: typed.lng, name: null, place: await placeFor(db, typed.lat, typed.lng), url: `https://www.google.com/maps?q=${typed.lat},${typed.lng}` };
  }
  const start = firstUrl(text.trim());
  if (!start || !isMapsHost(start)) { console.log(JSON.stringify({ resolve_venue: 'not_maps_link', text: text.slice(0, 200) })); return { error: 'not_maps_link' }; }
  // desktop browser: a phone browser gets Google's "Open in app?" page instead of the map
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en' };
  let url = start, name = nameFrom(url), c = coordsFrom(url) ?? await fromPlusCode(text, db);
  try { const x = new URL(url); x.searchParams.delete('g_st'); url = x.toString(); } catch { /* keep */ }   // iPhone share tag
  const hops: string[] = [start.slice(0, 160)];
  try {
    for (let hop = 0; !c && hop < 6; hop++) {
      const r = await fetch(url, { redirect: 'manual', headers: UA, signal: AbortSignal.timeout(5000) });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        const next = new URL(loc, url).toString();
        hops.push(next.slice(0, 160));
        // a pasted Google/Apple link may pass through other Google/Apple pages; read what we can from each, never follow elsewhere
        name = nameFrom(next) ?? name; c = coordsFrom(next) ?? await fromPlusCode(next, db);
        if (!isMapsRedirect(next)) break;
        if (/consent\.google\.com/.test(next)) { const cont = new URL(next).searchParams.get('continue'); if (cont && isMapsRedirect(cont)) { url = cont; name = nameFrom(url) ?? name; c = coordsFrom(url); } else break; }
        else if (/\/sorry\//.test(next)) { const cont = new URL(next).searchParams.get('continue'); if (cont) { name = nameFrom(cont) ?? name; c = coordsFrom(cont); } break; }
        else url = next;
        continue;
      }
      hops.push(`${r.status}`);
      if (r.ok && isListLink(url)) { await r.body?.cancel(); break; }   // a shared saved-places list has no single pin
      if (r.ok) {
        const html = (await r.text()).slice(0, 800000);
        c = coordsFromHtml(html);
        // "Open in app?" page: continue to the map link written inside it
        const inner = !c && /preview\.app\.goo\.gl/.test(url) ? html.match(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps[^"'\s<>\\]*/)?.[0]?.replace(/&amp;/g, '&') : null;
        if (inner && hop < 5) { url = inner; name = nameFrom(url) ?? name; c = coordsFrom(url); if (!c) continue; }
      }
      else await r.body?.cancel();
      break;
    }
  } catch (e) { hops.push(`error ${String(e).slice(0, 80)}`); /* fall through to the name search */ }
  let approx = false;
  // Google's own map search for the exact text Google wrote into the link (name + address) gives Google's exact pin.
  // Then the Places API if a key is set. Never a pin from a third-party name search.
  let via = c ? 'link' : '';
  // with a key, Google's official Places API first; Google Maps' public search as the keyless fallback
  if (!c && name) { const g = await googlePlace(name); if (g) { c = g; via = 'google-places'; } }
  if (!c && name) { const g = await googleMapSearch(name); if (g) { c = g; via = 'google-search'; } }
  // otherwise only the area: the phone shows the map there and the person taps the exact venue (never a pin from a name)
  if (!c && name) {
    const parts = name.split(',').map((x) => x.trim()).filter(Boolean);
    // the map only opens on this area, so the locality and PIN (end of the address) beat the business name (start)
    const pin = name.match(/\b\d{6}\b/)?.[0];
    const tries = [...new Set([parts.slice(-3).join(', '), parts.slice(-2).join(', '), pin ? `${pin}, India` : '', name].filter(Boolean))];
    const deadline = Date.now() + 9000;
    for (const q of tries) { if (Date.now() > deadline) break; const g = await geocodeArea(q, deadline); if (g) { c = g; approx = true; via = 'area'; break; } }
  }
  if (!c) {
    console.log(JSON.stringify({ resolve_venue: 'no_pin', name, hops }));
    return { error: isListLink(url) ? 'list_link' : 'no_pin' };
  }
  name = name?.replace(/^[23456789CFGHJMPQRVWX]{4,8}[+ ][23456789CFGHJMPQRVWX]{2,3}[\s,]*/i, '').trim() || null;   // drop the Plus Code from the name
  console.log(JSON.stringify({ resolve_venue: 'ok', via, name: name?.slice(0, 80), lat: c.lat, lng: c.lng, start: start.slice(0, 80) }));
  if (approx) return { lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)), name, place: null, url: start, approx: true };   // area only: the phone asks for a tap
  return { lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)), name, place: await placeFor(db, c.lat, c.lng), url: start };
}

// Reverse geocode, cached by coordinates rounded to 4 decimals (~11 m) (PRD LC-09)
// deno-lint-ignore no-explicit-any
async function placeFor(db: any, lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const { data: hit } = await db.from('geo_cache').select('place_name').eq('key', key).maybeSingle();
  if (hit) return hit.place_name;
  let name: string | null = null;
  const gkey = gkeyOf();
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
  const okey = env('OLA_MAPS_KEY');
  if (!name && okey) {
    // Ola Maps (India): free up to 100,000 calls a month, Indian place names
    try {
      const r = await fetch(`https://api.olamaps.io/places/v1/reverse-geocode?latlng=${lat},${lng}&api_key=${okey}`,
        { headers: { 'X-Request-Id': crypto.randomUUID() }, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        const res0 = j?.results?.[0];
        const comps = res0?.address_components ?? [];
        const pick = (t: string) => comps.find((c: { types: string[] }) => c.types?.includes(t))?.long_name;
        name = [pick('route'), pick('sublocality') ?? pick('sublocality_level_1') ?? pick('neighborhood'), pick('locality')].filter(Boolean).join(', ')
          || (res0?.formatted_address ? String(res0.formatted_address).split(',').slice(0, 3).join(',').trim() : null);
      }
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
