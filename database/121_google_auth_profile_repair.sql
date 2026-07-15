-- =====================================================================
-- 121_google_auth_profile_repair.sql
-- =====================================================================
-- Repairs Google OAuth signups where auth.users exists but public.profiles
-- was not created, and exposes a safe self-heal RPC for the mobile app.
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.display_id_seq
  START WITH 202701
  INCREMENT BY 1
  MINVALUE 202701
  NO CYCLE;

CREATE OR REPLACE FUNCTION public.next_profile_display_id()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_display_id BIGINT;
BEGIN
  LOOP
    new_display_id := nextval('public.display_id_seq');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE display_id = new_display_id
    );
  END LOOP;

  RETURN new_display_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_display_id BIGINT;
BEGIN
  new_display_id := public.next_profile_display_id();

  INSERT INTO public.profiles (id, display_id, full_name, phone_number, avatar_url)
  VALUES (
    NEW.id,
    new_display_id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1), 'New User'),
    COALESCE(NEW.raw_user_meta_data->>'phone', NEW.phone),
    COALESCE(
      NEW.raw_user_meta_data->>'avatar_url',
      NEW.raw_user_meta_data->>'picture',
      'https://api.dicebear.com/7.x/avataaars/svg?seed=' || NEW.id::TEXT
    )
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.ensure_my_profile()
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  auth_user auth.users%ROWTYPE;
  profile_row public.profiles%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO profile_row
    FROM public.profiles
   WHERE id = me;

  IF FOUND THEN
    RETURN profile_row;
  END IF;

  SELECT * INTO auth_user
    FROM auth.users
   WHERE id = me;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auth user not found';
  END IF;

  INSERT INTO public.profiles (id, display_id, full_name, phone_number, avatar_url)
  VALUES (
    auth_user.id,
    public.next_profile_display_id(),
    COALESCE(auth_user.raw_user_meta_data->>'full_name', auth_user.raw_user_meta_data->>'name', split_part(auth_user.email, '@', 1), 'New User'),
    COALESCE(auth_user.raw_user_meta_data->>'phone', auth_user.phone),
    COALESCE(
      auth_user.raw_user_meta_data->>'avatar_url',
      auth_user.raw_user_meta_data->>'picture',
      'https://api.dicebear.com/7.x/avataaars/svg?seed=' || auth_user.id::TEXT
    )
  )
  ON CONFLICT (id) DO UPDATE
    SET full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
        avatar_url = COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url)
  RETURNING * INTO profile_row;

  RETURN profile_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_my_profile() TO authenticated;
