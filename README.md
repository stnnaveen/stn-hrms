# StartupTN HR — v1 (PWA)

Staff check in with a selfie and location from a home-screen app. HR, Chairman and Tech admin views come in the next slices; their backend (roles, approvals, flags, audit) is already in the database.

## What works in this build
- Sign in with an email code (staff must be added by HR first) or Google
- Consent screen (DPDP) before the first check-in
- Daily greeting, home with today's times, month counts and requests
- Check-in and check-out: live front camera, face guide, blink or head-turn prompt, best GPS reading in 10 s, selfie upload, server rules
- Early checkout sheets (under 1 hour: confirm; over 1 hour: early leave or urgent OD)
- Offline check-in: saved on the phone, sent when back online
- OD (hours, full day, days) and leave requests; notifications
- Demo mode: runs with sample data when no Supabase keys are set

## Try it now (demo mode)
```
npm install
npm run dev        # open the URL on your phone (same Wi-Fi) or desktop
```

## Go live: one-time setup
1. **Supabase** (Mumbai region): create the project, then
   ```
   npx supabase link --project-ref YOUR_REF
   npx supabase db push            # runs supabase/migrations (also seeds hubs and the 3 role logins)
   ```
   Or let GitHub do it: add `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN` as Actions secrets; every push to main deploys.
2. **Auth**: enable Email and Google. Keep "Allow new users to sign up" **on**: the database only accepts emails on the staff roster. Edit the **Magic Link** email template so it sends the 6-digit code (`{{ .Token }}`). Set SMTP to **Resend** (verify startuptn.in with SPF, DKIM, DMARC first); the built-in mailer sends only a few emails an hour.
3. **AWS (StartupTN account, ap-south-1)**: S3 bucket `stn-hr-selfies` (private, encrypted, lifecycle: delete `selfies/` after 90 days, CORS: PUT from your app domain). IAM user/role with `s3:PutObject`, `s3:GetObject` on the bucket and `rekognition:CompareFaces`.
4. **Edge function**:
   ```
   npx supabase secrets set AWS_REGION=ap-south-1 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... S3_SELFIE_BUCKET=stn-hr-selfies GOOGLE_GEOCODING_KEY=...
   npx supabase functions deploy check-in
   ```
5. **Frontend**: copy `.env.example` to `.env`, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, `npm run build`, host `dist/` on HTTPS (Vercel, Netlify or S3 + CloudFront). Camera and GPS need HTTPS.
6. **Data**: replace each hub's placeholder coordinates with its real pin. Load staff into `staff_roster` (from `data/staff_template.csv`); they sign in with their email code, no invite needed. The three role logins (hr@, chairmanoffice@, ai@startuptn.in) are already on the roster.

## Install on phones
- **Android (Chrome)**: open the link, tap **Install app** (or menu > Add to Home screen).
- **iPhone (Safari)**: open the link, Share > **Add to Home Screen**. Open it from the icon, not from Safari, so notifications and storage work.

## Known limits of v1 (fixed in v2 store apps)
- Browsers do not expose the mock-location flag, rooted-phone checks or app integrity. Server checks still catch identical points, impossible jumps, clock changes and face mismatch.
- Clearing browser data counts as a new phone and needs Tech admin approval.
- Reference photo enrolment, the watermark burned into the stored selfie, HR / Chairman / Tech admin screens and push notifications come in the next slices.

## Tests
- `npm run test:rules` — attendance rules (bands, radius, location changer, jump, clock, offline, face)
- `supabase/tests/rls_test.sql` — security promises (staff cannot see radius or flags, approvals routing, role changes, audit chain)
