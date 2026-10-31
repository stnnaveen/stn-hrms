// node --experimental-strip-types supabase/tests/rules.test.ts
import { evaluate, bandFor, DEFAULT_SETTINGS as S, haversineM } from '../functions/_shared/rules.ts';
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
const ist = (h: number, m: number) => new Date(Date.UTC(2026, 9, 30, h, m) - 330 * 60000);
const hub = { lat: 13.0108, lng: 80.2206, radiusM: 500 };
const base = { kind: 'in' as const, clientTime: ist(9, 55), serverTime: ist(9, 55), fix: { lat: 13.0110, lng: 80.2210, accuracy: 12, mocked: false },
  target: hub, faceSimilarity: 96, liveness: { challenge: 'blink', passed: true }, recentDays: [], lastPunch: null, integrityOk: null, settings: S };

ok(bandFor(ist(10, 0), S) === 'ok', '10:00 is on time');
ok(bandFor(ist(10, 1), S) === 'warn', '10:01 is slightly late');
ok(bandFor(ist(10, 15), S) === 'warn', '10:15 is slightly late');
ok(bandFor(ist(10, 16), S) === 'bad', '10:16 is late');
ok(Math.abs(haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111195) < 50, 'haversine 1° ≈ 111.2 km');

let e = evaluate(base);
ok(e.inside && e.flags.length === 0 && e.status === 'recorded' && e.quality === 100, 'clean check-in: inside, no flags, 100');

e = evaluate({ ...base, fix: { lat: 13.0230, lng: 80.2206, accuracy: 14 } });
ok(!e.inside && e.flags.some(f => f.kind === 'radius') && e.status === 'review', '1.36 km away flags radius');

e = evaluate({ ...base, fix: { lat: 13.0153, lng: 80.2206, accuracy: 30 } }); // ~500 m + accuracy credit
ok(e.inside, 'edge of radius passes with accuracy credit');

e = evaluate({ ...base, fix: { lat: 13.0400, lng: 80.2206, accuracy: 3000 } });
ok(!e.inside, 'huge accuracy cannot buy its way inside (credit capped at 100 m)');

const same = { lat: 11.93941, lng: 79.48623, accuracy: 5 };
const days = [1, 2, 3, 4].map(d => ({ ...same, at: ist(9, 50 - d) }));
e = evaluate({ ...base, target: { lat: 11.9394, lng: 79.4862, radiusM: 500 }, fix: same, recentDays: days });
ok(e.flags.some(f => f.kind === 'location_changer') && e.quality <= 55, 'identical point 5 days flags location changer');

const jitter = [1, 2, 3, 4].map(d => ({ lat: 11.93941 + d * 0.00004, lng: 79.48623, accuracy: 9 + d, at: ist(9, 50 - d) }));
e = evaluate({ ...base, target: { lat: 11.9394, lng: 79.4862, radiusM: 500 }, fix: { ...same, accuracy: 8 }, recentDays: jitter });
ok(!e.flags.some(f => f.kind === 'location_changer'), 'normal GPS jitter is not flagged');

e = evaluate({ ...base, fix: { ...base.fix, mocked: true } });
ok(e.flags.some(f => f.kind === 'mock_location'), 'mock flag recorded');

e = evaluate({ ...base, faceSimilarity: 71 });
ok(e.flags.some(f => f.kind === 'face') && e.status === 'review', 'face 71% goes to review');

e = evaluate({ ...base, faceSimilarity: null });
ok(!e.flags.some(f => f.kind === 'face'), 'no reference photo yet: no face flag');

e = evaluate({ ...base, serverTime: ist(10, 24), clientTime: ist(10, 24) });
ok(e.band === 'bad' && e.flags.some(f => f.kind === 'late') && e.status === 'recorded', 'late alone is recorded, not review');

e = evaluate({ ...base, clientTime: ist(9, 0), serverTime: ist(9, 55) });
ok(e.flags.some(f => f.kind === 'offline') && !e.flags.some(f => f.kind === 'clock'), '55 min late sync is offline, not clock');

e = evaluate({ ...base, clientTime: ist(9, 50), serverTime: ist(9, 55) });
ok(e.flags.some(f => f.kind === 'clock'), '5 min clock gap flags clock');

e = evaluate({ ...base, lastPunch: { lat: 9.9252, lng: 78.1198, accuracy: 10, at: ist(9, 0) } });
ok(e.flags.some(f => f.kind === 'jump'), 'Madurai to Chennai in 55 min flags jump');

e = evaluate({ ...base, kind: 'out', serverTime: ist(16, 30), clientTime: ist(16, 30) });
ok(e.earlyOut && e.band === null, '4:30 PM checkout is early out');


// ---- OD venue map links
import { firstUrl, isMapsHost, coordsFrom, nameFrom, coordsFromHtml } from '../functions/_shared/maplink.ts';
ok(firstUrl('TIDCO Office\nhttps://maps.app.goo.gl/AbC123xyz') === 'https://maps.app.goo.gl/AbC123xyz', 'finds the link in shared text');
ok(isMapsHost('https://maps.app.goo.gl/x') && isMapsHost('https://www.google.com/maps/place/x') && isMapsHost('https://maps.apple.com/?ll=1,2') && isMapsHost('https://maps.apple/p/abc'), 'Google and Apple Maps links accepted');
ok(!isMapsHost('https://evil.com/maps') && !isMapsHost('https://www.google.com/search?x=1') && !isMapsHost('Guindy, Chennai'), 'other links and typed places rejected');
const g = coordsFrom('https://www.google.com/maps/place/TIDCO/@13.0102,80.2101,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d13.0109!4d80.2117');
ok(!!g && g.lat === 13.0109 && g.lng === 80.2117, 'Google pin (!3d/!4d) beats map centre');
const a = coordsFrom('https://maps.apple.com/?address=Guindy,%20Chennai&ll=13.0067,80.2206&q=TIDCO');
ok(!!a && a.lat === 13.0067 && a.lng === 80.2206, 'Apple Maps ll= read');
ok(nameFrom('https://www.google.com/maps/place/Codissia+Trade+Fair+Complex/@11.03,77.03,17z') === 'Codissia Trade Fair Complex', 'place name from Google link');
ok(nameFrom('https://maps.apple.com/?ll=13.0,80.2&q=TIDCO%20Office') === 'TIDCO Office', 'place name from Apple link');
ok(coordsFromHtml('<meta content="https://maps.google.com/maps/api/staticmap?center=11.0301%2C77.0322&zoom=15">')?.lat === 11.0301, 'coordinates found in page');
ok(evaluate({ ...base, kind: 'visit' as const, serverTime: ist(14, 5), clientTime: ist(14, 5) }).flags.length === 0, 'venue check-in: no late or early-out flags');

process.exit(fails ? 1 : 0);
