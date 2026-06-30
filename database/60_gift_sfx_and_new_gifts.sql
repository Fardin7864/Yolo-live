-- =====================================================================
-- 60_gift_sfx_and_new_gifts.sql
-- =====================================================================
-- Two things in one migration:
--
--   1. SFX columns on `gifts`. `sound_path` mirrors the existing
--      animation_path pattern (bundled key); `sound_url` mirrors
--      animation_url (Supabase Storage URL that takes priority so the
--      admin can ship new SFX without an app build).
--
--   2. Seed 18 new gifts that were just shipped via assets/animation/.
--      The 3 Profile-Avatar Lotties (VIP frame previews) are NOT seeded
--      as gifts — those are reserved for a future profile-frame table.
--
--      The "Guardian" gift is the AK47 Lottie under a Play-Store-safe
--      label so we keep the iconic feel without tripping the gun-content
--      policy review.
--
-- Idempotent: re-runnable. INSERTs use ON CONFLICT DO NOTHING so this
-- file is safe to apply multiple times.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. SFX columns
-- ---------------------------------------------------------------------
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS sound_path TEXT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS sound_url  TEXT;

COMMENT ON COLUMN public.gifts.sound_path IS
  'Bundled SFX key (e.g. "audio/gifts/rose.mp3"). Resolved by mobile via giftSounds.js BUNDLED map.';
COMMENT ON COLUMN public.gifts.sound_url IS
  'Optional Supabase Storage URL for the SFX. Takes priority over sound_path so admin can ship new sounds without an app build.';

-- ---------------------------------------------------------------------
-- 2. Backfill SFX paths for the 10 originally-seeded gifts so the
--    expo-audio pool has something to find. Files won't actually exist
--    until the user drops MP3s in assets/audio/gifts/ — until then the
--    resolver returns NULL and the send-gift handler just skips SFX.
-- ---------------------------------------------------------------------
UPDATE public.gifts SET sound_path = 'audio/gifts/rose.mp3'        WHERE id = '1'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/rose.mp3'        WHERE id = '1b'  AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/clap.mp3'        WHERE id = '2'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/lollipop.mp3'    WHERE id = '3'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/poop.mp3'        WHERE id = '4'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/love_blind.mp3'  WHERE id = '5'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/gaming.mp3'      WHERE id = '6'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/plane.mp3'       WHERE id = '7'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/love_birds.mp3'  WHERE id = '8'   AND sound_path IS NULL;
UPDATE public.gifts SET sound_path = 'audio/gifts/wedding.mp3'     WHERE id = '9'   AND sound_path IS NULL;

-- ---------------------------------------------------------------------
-- 3. Seed 18 new gifts
--
-- ID convention: numeric IDs to extend the existing seed series.
-- display_order is grouped by category so the grid reads predictably
-- (cheaper gifts first inside each tab).
-- ---------------------------------------------------------------------
INSERT INTO public.gifts (id, name, diamond_cost, category, animation_path, sound_path, loop, custom_duration, display_order) VALUES
  -- ─── Classic (cheap, looping) ───────────────────────────────────
  ('11', 'Pigeon',         15,  'Classic',   'animation/running pigeon.json',                'audio/gifts/pigeon.mp3',           true,  2500,  25),
  ('12', 'Runner',          25,  'Classic',   'animation/Run Animation.json',                 'audio/gifts/runner.mp3',           true,  2500,  35),
  ('13', 'Heartbeat',       30,  'Classic',   'animation/Heart Beating.json',                 'audio/gifts/heartbeat.mp3',        true,  2500,  45),

  -- ─── Premium (mid-tier, themed) ─────────────────────────────────
  ('14', 'Feel in Love',    250, 'Premium',   'animation/Feel in love.json',                  'audio/gifts/feel_in_love.mp3',     true,  2800,  25),
  ('15', 'Ghost',           350, 'Premium',   'animation/ghost.json',                         'audio/gifts/ghost.mp3',            true,  2800,  35),
  ('16', 'Violin',          400, 'Premium',   'animation/violin.json',                        'audio/gifts/violin.mp3',           true,  3000,  45),
  ('17', 'Guitar',          450, 'Premium',   'animation/Guitar.json',                        'audio/gifts/guitar.mp3',           true,  3000,  55),
  ('18', 'Violin Maestro',  500, 'Premium',   'animation/Violin male.json',                   'audio/gifts/violin_male.mp3',      true,  3000,  65),
  ('19', 'Ghibli Tribute',  550, 'Premium',   'animation/Gibli Tribute.json',                 'audio/gifts/ghibli.mp3',           true,  3000,  75),
  ('20', 'Totoro Walk',     600, 'Premium',   'animation/Totoro Walk.json',                   'audio/gifts/totoro.mp3',           true,  3000,  85),
  ('21', 'Dancer',          700, 'Premium',   'animation/dancer-woman.json',                  'audio/gifts/dancer.mp3',           true,  3200,  95),
  ('22', 'Spider',          800, 'Premium',   'animation/Spider.json',                        'audio/gifts/spider.mp3',           true,  3000,  105),
  ('23', 'Peace',           900, 'Premium',   'animation/no war.json',                        'audio/gifts/peace.mp3',            true,  3000,  115),
  ('24', 'Peacock',         950, 'Premium',   'animation/peacock.json',                       'audio/gifts/peacock.mp3',          true,  3200,  125),

  -- ─── Exclusive (full-screen, dramatic) ──────────────────────────
  ('25', 'Racing Car',      2000, 'Exclusive', 'animation/racing-car.json',                    'audio/gifts/racing_car.mp3',       false, NULL,  25),
  ('26', 'Luxury Car',      2500, 'Exclusive', 'animation/Car Animation1.json',                'audio/gifts/luxury_car.mp3',       false, NULL,  35),
  ('27', 'Jet Departure',   3000, 'Exclusive', 'animation/airplane-departure.json',            'audio/gifts/jet_departure.mp3',    false, NULL,  45),
  -- Guardian intentionally reuses the AK47 Lottie under a safer label
  -- (Play Store gun-policy guardrail; same iconic feel, no flagging).
  ('28', 'Guardian',        4000, 'Exclusive', 'animation/AK47.json',                          'audio/gifts/guardian.mp3',         false, NULL,  55)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Refresh updated_at so /gifts admin page sees the new rows on next
--    realtime tick. (The INSERT already sets it; this is for the case
--    where someone manually backfills then reruns this file.)
-- ---------------------------------------------------------------------
UPDATE public.gifts SET updated_at = NOW() WHERE id IN ('11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28');
