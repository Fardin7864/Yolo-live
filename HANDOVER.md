# Yolo-Live Handover — May 27, 2026

## ⚠️ Action Required Before Resuming

Run these 5 SQL files in **Supabase SQL Editor** (in order):

```
database/13_harden_profile_rls.sql    ← CRITICAL security hardening
database/14_moments_counters.sql      ← For explore screen + image uploads
database/15_system_settings.sql       ← For admin Settings page
database/16_live_heartbeat.sql        ← For app-kill detection on live streams
database/17_music_tracks.sql          ← For real music playback in broadcast
```

Without these, several features will throw errors. Verify after running:

```sql
SELECT proname FROM pg_proc
 WHERE proname IN ('admin_update_user', 'leave_agency', 'update_system_settings');
```

Should return all 3 names. Also verify the new heartbeat / music RPCs:

```sql
SELECT proname FROM pg_proc
 WHERE proname IN ('live_stream_heartbeat', 'cleanup_stale_live_streams');
```

And the music tracks table:

```sql
SELECT COUNT(*) FROM public.music_tracks;
```

---

## ✅ Completed in This Session (6-Priority Roadmap)

### Priority 1 — Security
- `profiles_update_self` trigger blocks user-side edits to diamonds/beans/role/is_banned/display_id/agency_id/level/vip_type/phone_number
- Admin panel users page → uses `admin_update_user` RPC (audit-logged)
- `agency-host-view.js` → uses `leave_agency` RPC (direct UPDATE blocked by new trigger)

### Priority 2 — Mock Screens → Real DB
- `app/main/notifications.js` — real `notifications` table, realtime, auto-mark-read
- `app/main/(tabs)/messages.js` — real `chat_messages` aggregation by `conversation_id`
- `app/main/chat/[id].js` — real chat with realtime INSERT + optimistic UI
- `app/main/(tabs)/explore.js` — real `moments_posts`, post creation w/ storage, like/unlike, comments

### Priority 3 — Admin Panel
- `src/app/analytics/page.tsx` — live count, signups, gifts, top tags, hourly bars (real)
- `src/app/earnings/page.tsx` — range selector, real cash flow, top agencies
- `src/app/settings/page.tsx` — backed by `system_settings` table + save logic

### Priority 4 — Responsiveness
- Tab bar uses `useSafeAreaInsets().bottom`
- Profile wallet boxes use `useWindowDimensions()`

### Priority 5+6 — Cleanup
- Deleted `src/utils/dummyData.js`
- Removed unused imports + state from `app/broadcast/[id].js`
- Fixed deprecated `.substr()` calls

### Bonus — Modal UX
- Removed outside-tap-dismiss from **17 modals** across `wallet.js`, `earnings.js`, `agency-owner-view.js`, `explore.js`, `broadcast/[id].js`. Now dismissed only by hardware back button or explicit close (X).

---

## ✨ May 27 Session Adds

### Maintenance Mode Honoring
- `src/context/GlobalStateContext.js` loads `system_settings` on init + realtime-subscribes
- New `src/components/MaintenanceGate.js` wraps the app in `app/_layout.js`. When `maintenance_mode=true`, blocks normal screens and shows a friendly maintenance UI. Admins bypass.

### App-Kill Detection
- New `live_streams.last_heartbeat_at` column (migration 16)
- New `live_stream_heartbeat` RPC — host's broadcast screen pings every 30s
- New `cleanup_stale_live_streams` RPC — marks any 'live' row with stale heartbeat (> 90s) as 'ended'
- Home feed calls cleanup on every refresh + filters by recent heartbeat as a defense-in-depth
- pg_cron schedule attempts to run cleanup every minute (silently skips if pg_cron isn't enabled)

### Music Modal — Real Audio Playback
- New `music_tracks` table + `music` storage bucket (migration 17, admin-only write)
- Broadcast screen uses `expo-audio` `createAudioPlayer` for streaming playback
- Now Playing card with Play/Pause/Stop controls, loops by default, 0.5 volume
- "Now Playing" marquee in live room now opens the picker again (tap to control)
- Modal shows "No tracks yet" message when DB is empty (with hint to admins)

### Tablet / Landscape Responsiveness
- New `src/hooks/useResponsive.js` — returns `{isPhone, isTablet, isLargeTablet, gridColumns, maxContentWidth, isLandscape}`
- Home feed grid adapts: 2 cols on phone, 3 on tablet, 4 on large tablet
- Profile + Settings wrap content in a max-width container so layouts don't stretch awkwardly on tablets
- App stays portrait-locked for live streaming UX (per app.json) but content adapts properly when device is larger or in side-by-side mode

## 🔜 Remaining Open Items

- **Mic-level metering** — currently hardcoded 0.6 when unmuted; needs ZegoCloud
- **ZegoCloud integration** — real video/audio streaming (placeholder using camera preview now)
- **Admin panel music uploader** — currently admins must upload music tracks directly via Supabase dashboard. Could add a small CRUD page to `yolo-admin-panel`.

---

## 📁 Recently Modified Files

**Mobile:**
- `app/index.js` (session-aware redirect)
- `app/main/(tabs)/_layout.js` (safe-area-driven tab bar)
- `app/main/(tabs)/profile.js` (real DB stats, responsive width)
- `app/main/(tabs)/messages.js` (real chat_messages)
- `app/main/(tabs)/explore.js` (moments_posts + likes + comments)
- `app/main/(tabs)/live.js` (real user.avatar cover)
- `app/main/chat/[id].js` (real-time chat)
- `app/main/notifications.js` (real notifications table)
- `app/main/wallet.js` (modal UX)
- `app/main/earnings.js` (modal UX)
- `app/main/agency-host-view.js` (leave_agency RPC)
- `app/main/agency-owner-view.js` (modal UX)
- `app/broadcast/[id].js` (cleanup + modal UX)
- `src/context/GlobalStateContext.js` (myReseller, helpers)

**Admin Panel:**
- `src/app/analytics/page.tsx`
- `src/app/earnings/page.tsx`
- `src/app/settings/page.tsx`
- `src/app/users/page.tsx` (Crown promote + admin_update_user RPC)

**Database:**
- `13_harden_profile_rls.sql`, `14_moments_counters.sql`, `15_system_settings.sql`

---

## 👤 Super Admin

UID: `63b8d18d-50e7-4eba-975b-b043db715ca4`

If locked out due to RLS regression, run in Supabase:
```sql
UPDATE profiles SET role = 'super_admin' WHERE id = '63b8d18d-50e7-4eba-975b-b043db715ca4';
```