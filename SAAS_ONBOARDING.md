# SaaS Onboarding — Deploy This App for a New Tenant

This codebase is a multi-tenant white-label live-streaming app.
Spinning up a new branded copy for a customer takes **about 30
minutes of focused work** if you follow the steps below in order.

The core idea: **one file controls everything tenant-specific**.
That file is `tenant.config.js` at the project root. Edit it, swap
two images, run a build. Done.

---

## Prerequisites (one-time, per your studio — NOT per tenant)

- Node.js 20+
- `npm install -g eas-cli`
- An EAS / Expo account that can host multiple projects
- A signed contract with the tenant (this is a sales decision, not
  an engineering one)

---

## What you need from the tenant up front

Collect this in a single intake form so you're not chasing them mid-build:

| Field | Example |
|---|---|
| Brand name | "X Live" |
| Short brand name (for tight UI) | "X" |
| Android package id | `com.xlive.app` (must be globally unique on Play Store) |
| Brand primary colour (hex) | `#FF6B35` |
| Brand splash background (hex) | `#1A1230` |
| Share / landing domain | `https://xlive.app` |
| Logo PNG (1024 × 1024, transparent) | — |
| Loader GIF (256 × 256, transparent loop, ≤ 200 KB) | — |
| Their Play Store developer account | We submit on their behalf, or we hand off the APK |
| Their privacy policy + terms URL | Play Store requires both |

---

## Step 1 — Provision the tenant's Supabase project (~10 min)

1. Log in at https://supabase.com → **New project**
2. Name: `tenantx-live`, region closest to their users (Singapore for Asia)
3. Wait for the project to finish provisioning
4. Open **Settings → API**, copy:
   - `Project URL` (looks like `https://xxxxx.supabase.co`)
   - `anon public` key (long JWT)
5. **Run migrations**:
   - Open the Supabase SQL editor
   - Paste-and-run every file from `database/` in numeric order
   - Files `01_*.sql` and `64_*.sql` don't exist — that's intentional, skip them
   - Last file should be `71_task_bean_rewards.sql`
6. **Deploy the Agora token edge function**:
   - Install Supabase CLI locally: `npm install -g supabase`
   - `supabase login`
   - `supabase functions deploy agora-token --project-ref <project-ref>`
   - In the Supabase dashboard → **Edge Functions → agora-token → Secrets**, add:
     - `AGORA_APP_ID` = (from tenant's Agora project — next step)
     - `AGORA_APP_CERT` = (from tenant's Agora project)

## Step 2 — Provision the tenant's Agora project (~5 min)

1. Log in at https://console.agora.io → **Project Management → Create**
2. Authentication mode: **App ID + Token (recommended)**
3. Copy the **App ID** and **Primary Certificate**
4. Paste both into the Supabase edge-function secrets (Step 1.6)

## Step 3 — Edit `tenant.config.js` (~5 min)

Open `tenant.config.js` at the project root and fill in:

```js
appName:   'X Live',
shortName: 'X',
bundleId:  'com.xlive.app',
scheme:    'xlive',
slug:      'xlive',
owner:     'your-eas-account',

primaryColor:      '#FF6B35',
primaryAlt:        '#D946EF',
splashBg:          '#1A1230',
shareDomain:       'https://xlive.app',
signupEmailDomain: 'xlive.app',

supabase: {
  url:     'https://xxxxx.supabase.co',
  anonKey: 'eyJhbGc...',
},

eas: {
  projectId: '<from-eas-create-below>',
  updateUrl: 'https://u.expo.dev/<from-eas-create-below>',
},
```

## Step 4 — Swap assets (~2 min)

Drop the tenant's two images into the `assets/` folder, replacing
the existing files:

- `assets/splash-icon.png` — main logo (square, transparent BG, ≥ 1024×1024)
- `assets/loader/logo-loader.gif` — branded spinner shown during loading

That single PNG is reused as:
- app launcher icon (Android & iOS)
- splash-screen logo
- Android adaptive-icon foreground
- Web favicon

## Step 5 — Create a new EAS project (~2 min)

```powershell
cd "f:\All Website Developmeent\Yolo-live"
npx eas init --id <leave-blank-to-auto-create>
```

EAS prints a `projectId` and `updateUrl`. Paste both back into
`tenant.config.js → eas.{projectId, updateUrl}`.

## Step 6 — Build the APK (~15-25 min cloud build)

```powershell
npx eas build --profile preview --platform android
```

EAS emails the APK link when ready. Share it with the tenant for
internal testing.

For Play Store submission, swap the profile:

```powershell
npx eas build --profile production --platform android
```

This produces an `.aab` (app bundle) that uploads to Play Console.

## Step 7 — Promote the tenant's first super_admin

In the new Supabase project:

```sql
-- After the tenant's first user signs up, find their UUID:
SELECT id, full_name FROM public.profiles WHERE phone_number = '+8801xxxxxxxxx';

-- Promote them:
UPDATE public.profiles SET role = 'super_admin' WHERE id = '<their-uuid>';
```

They can now log into the admin panel at the URL you deploy in
Step 8.

## Step 8 — Deploy a per-tenant admin panel (~5 min)

The Next.js admin panel sits in a sibling folder
(`yolo-admin-panel`). For each tenant:

1. Deploy a copy to Vercel (or any Next.js host)
2. Set two environment variables for that deployment:
   - `NEXT_PUBLIC_SUPABASE_URL` = tenant's Supabase URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = tenant's anon key
3. Point the tenant's subdomain (e.g. `admin.xlive.app`) at the
   Vercel project

## Step 9 — Smoke-test the build

Install the APK on a real phone, then walk through:

- [ ] App icon + launcher name reflect the tenant brand
- [ ] Splash screen colour matches `splashBg`
- [ ] Signup with a real phone number completes
- [ ] Loader GIF spins on the home tab
- [ ] Open a live stream — share button copies a `${shareDomain}/live/…` URL with the tenant's brand name
- [ ] Send a 100💎 gift — admin panel's earnings dashboard reflects it
- [ ] Admin panel `/users` lists the new signup

If everything is green, hand the APK off to the tenant.

---

## Brand depth — going beyond the config file

`tenant.config.js` covers the **identity** layer (name, colours,
icons, URLs). The existing codebase still has plenty of inline
`#FF2E7E` and `#D946EF` literals scattered across screens. They
still work for a Yolo-style brand, but if a tenant wants a fully-
recoloured palette:

1. Run a project-wide search for `#FF2E7E` and `#D946EF`
2. Replace each with `BRAND.primary` / `BRAND.primaryAlt`
3. Add `import { BRAND } from '../theme/brand';` to every file you
   touched

This is a one-time investment per tenant who really wants a deep
custom look. Most live-streaming apps end up close to a pink /
purple gradient anyway, so don't volunteer this work — wait for the
tenant to ask.

---

## When you push an upstream bug fix

You're maintaining a shared codebase but separate Supabase projects.
A migration shipped this week needs to land in every tenant's DB:

```powershell
# For each tenant project:
# 1. supabase link --project-ref <theirs>
# 2. Run the new migration .sql files from database/ in numeric order
```

A small script that loops over the projects you maintain is worth
writing once you have 3+ tenants. Until then, manual is fine.

---

## When a tenant churns

The data they generated belongs to them. The contract should
specify:

1. You hand them a final Supabase backup (`pg_dump`)
2. You retain the original codebase / branding for 30 days
3. You delete the Supabase project after that window unless they
   pay for an extended dormant period

Nothing in the code needs to change — they just stop receiving new
APKs from you.
