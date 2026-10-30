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

process.exit(fails ? 1 : 0);
