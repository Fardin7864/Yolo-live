-- =====================================================================
-- RESTORE SUPER ADMIN ACCESS
-- After running 07_fix_role_enum.sql, the admin panel started rejecting
-- login with "Access denied. This panel is for admins only."
-- That means profiles.role for your account is no longer 'super_admin'.
--
-- Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Diagnostic: see ALL columns in your profile row + phone from auth.users
SELECT
  p.*,
  u.phone AS auth_phone,
  pg_typeof(p.role) AS role_type   -- should say 'text' after migration 07
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id
WHERE p.id = '63b8d18d-50e7-4eba-975b-b043db715ca4';

-- 2. Restore super_admin role (only touch columns that exist)
UPDATE public.profiles
SET role = 'super_admin'
WHERE id = '63b8d18d-50e7-4eba-975b-b043db715ca4';

-- 3. Verify
SELECT id, role, pg_typeof(role) AS role_type
FROM public.profiles
WHERE id = '63b8d18d-50e7-4eba-975b-b043db715ca4';

-- =====================================================================
-- After this, log out and log back in to the admin panel.
-- =====================================================================