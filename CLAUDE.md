# StartupTN HR — rules for Claude Code

Attendance, OD and leave for ~100 StartupTN staff across 10 hubs.
v1 = PWA (Add to Home Screen). v2 = the same code wrapped with Capacitor for Play Store and App Store.
Specs: PRD and TRD (Claude Docs). UI spec: the four HTML prototypes (Staff, HR, Chairman, Tech admin).

## Stack
- Frontend: Vite + React 18 + TypeScript, plain CSS ported from the prototypes (`src/styles/app.css`). No UI kit.
- Backend: Supabase (Mumbai): Postgres, Auth (email code + Google), RLS, Edge Functions (Deno), pg_cron.
- Files and face match: StartupTN's AWS (S3 + Rekognition, ap-south-1), called only from edge functions.

## Non-negotiable rules
1. **Every attendance decision is made on the server** (`supabase/functions/_shared/rules.ts`). The app sends evidence; it never decides on-time, inside/outside or pass/fail.
2. **Staff never learn about radius checks or flags.** No distance, radius, inside/outside, face score or flag may reach a staff screen, API reply, notification or error message. Staff read punches only through the `my_punches` view and hubs through `hub_directory`.
3. **RLS on every table.** New table = enable RLS + policies + a test in `supabase/tests/rls_test.sql` in the same change.
4. **Phone features only through `src/device/*`.** Screens never call `navigator.geolocation`, `getUserMedia` or storage directly. This is what lets v2 swap in Capacitor plugins.
5. **Never block a staff member.** Low face score, failed liveness or a bad GPS reading saves the punch "In review" and flags HR.
6. **Audit.** Changes to people, hubs, roles, settings, devices, requests and flags are logged by trigger. Never update or delete `audit_log`.
7. **Only the Tech admin changes roles or role logins** (enforced by `guard_profile_role`).
8. Copy: one line per message, one- or two-word buttons, no filler. Match the prototypes.

## Layout
- `src/screens/*` screens · `src/device/*` phone layer · `src/lib/api.ts` all backend calls (demo mode when no env)
- `supabase/migrations/*` schema, RLS, RPCs · `supabase/functions/check-in` check-in/out · `supabase/tests/*` tests

## Commands
- `npm run dev` · `npm run build` · `npm run test:rules`
- Database tests: run migrations + `supabase/tests/rls_test.sql` on a scratch database; every line must print PASS.
- Database change = new migration file, never edit an applied one.
