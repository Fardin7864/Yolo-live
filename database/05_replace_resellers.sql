-- =====================================================================
-- REPLACE DEMO RESELLERS WITH REAL ONES
-- Run in Supabase SQL Editor
-- =====================================================================

-- 1. Remove placeholder demo resellers (keeps any topup_requests tied to them)
--    If you have pending topup_requests, this will fail — first cancel them.
DELETE FROM public.resellers
WHERE contact_link LIKE '%8801XXXXXXXXX%';

-- 2. Add your real resellers — replace numbers + names below
INSERT INTO public.resellers (name, contact_link, type, status, priority, avatar_url) VALUES
  -- Example: change these to your real values
  ('Your Reseller 1', 'https://wa.me/8801712345678', 'official', 'active', 100, 'https://i.pravatar.cc/150?u=reseller1'),
  ('Your Reseller 2', 'https://wa.me/8801812345678', 'agency',   'active', 90,  'https://i.pravatar.cc/150?u=reseller2');

-- 3. Verify
SELECT name, contact_link, type, status, priority FROM public.resellers ORDER BY priority DESC;