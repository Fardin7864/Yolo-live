-- Dashboard staff accounts, hierarchy and per-module access.
-- Account credentials are created by the admin panel's server route with the
-- service-role key. Browsers can read only the access rows allowed here.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'user','host','reseller','agency_owner','manager','moderator','admin','super_admin'
  ));

CREATE TABLE IF NOT EXISTS public.admin_accounts (
  profile_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin','admin','manager','moderator','agency_owner')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  email TEXT,
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_accounts_permissions_object CHECK (jsonb_typeof(permissions) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_email_unique
  ON public.admin_accounts (LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_phone_unique
  ON public.admin_accounts (phone) WHERE phone IS NOT NULL;

INSERT INTO public.admin_accounts (profile_id, role, is_active)
SELECT id, 'super_admin', TRUE
FROM public.profiles
WHERE role IN ('super_admin','admin')
ON CONFLICT (profile_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_super_admin(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_accounts
    WHERE profile_id = uid AND role = 'super_admin' AND is_active
  ) OR EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = uid AND role = 'super_admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_accounts
    WHERE profile_id = uid AND is_active
  ) OR EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = uid AND role = 'super_admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.has_admin_permission(
  uid UUID,
  module_key TEXT,
  required_level TEXT DEFAULT 'view'
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_super_admin(uid) OR EXISTS (
    SELECT 1
    FROM public.admin_accounts a
    WHERE a.profile_id = uid
      AND a.is_active
      AND (
        a.permissions ->> module_key = 'manage'
        OR (required_level = 'view' AND a.permissions ->> module_key = 'view')
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.get_my_admin_access()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  result JSONB;
BEGIN
  IF me IS NULL THEN
    RETURN jsonb_build_object('success', FALSE);
  END IF;

  SELECT jsonb_build_object(
    'success', TRUE,
    'profile_id', p.id,
    'full_name', COALESCE(p.full_name, 'Admin'),
    'role', COALESCE(a.role, 'super_admin'),
    'permissions', COALESCE(a.permissions, '{}'::jsonb),
    'is_active', COALESCE(a.is_active, TRUE)
  ) INTO result
  FROM public.profiles p
  LEFT JOIN public.admin_accounts a ON a.profile_id = p.id
  WHERE p.id = me
    AND (a.profile_id IS NOT NULL OR p.role = 'super_admin');

  RETURN COALESCE(result, jsonb_build_object('success', FALSE));
END;
$$;

ALTER TABLE public.admin_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_accounts_read ON public.admin_accounts;
CREATE POLICY admin_accounts_read ON public.admin_accounts FOR SELECT
  USING (profile_id = auth.uid() OR public.is_super_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.admin_accounts FROM anon, authenticated;
GRANT SELECT ON public.admin_accounts TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_admin_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_admin_permission(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON TABLE public.admin_accounts IS
  'Dashboard-only roles and module permissions. Auth credentials are managed server-side.';
