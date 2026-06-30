-- =====================================================================
-- ONE-TIME SETUP: Make yourself super_admin + create test agency
-- Your UID: 63b8d18d-50e7-4eba-975b-b043db715ca4
-- =====================================================================

-- 1. Promote yourself to super_admin
UPDATE public.profiles
   SET role = 'super_admin'
 WHERE id = '63b8d18d-50e7-4eba-975b-b043db715ca4';

-- 2. Create a test agency where you are the owner
INSERT INTO public.agencies (name, code, owner_id, status, payout_rate, host_conversion_rate, accumulated_beans, diamond_balance)
VALUES (
  'Yolo Galaxy Agency',
  'GALAXY-001',
  '63b8d18d-50e7-4eba-975b-b043db715ca4',
  'verified',
  1150,
  0.50,
  0,
  0
)
ON CONFLICT (code) DO NOTHING;

-- 3. Verify (optional — just shows what was set)
SELECT
  p.id,
  p.full_name,
  p.role,
  a.name AS owned_agency,
  a.code AS agency_code
FROM public.profiles p
LEFT JOIN public.agencies a ON a.owner_id = p.id
WHERE p.id = '63b8d18d-50e7-4eba-975b-b043db715ca4';