-- Reset current wealth levels for every profile except display IDs 111 and 112.
-- The two excluded users keep their existing levels and gift history.
-- Run this migration once in the Supabase SQL Editor.

BEGIN;

UPDATE public.profiles
SET level = 1
WHERE display_id IS NULL
   OR display_id::text NOT IN ('111', '112');

COMMIT;

-- Verification (optional):
-- SELECT display_id, full_name, level
-- FROM public.profiles
-- WHERE display_id::text IN ('111', '112')
-- ORDER BY display_id;
