-- =====================================================================
-- 39_promote_handles_repromote.sql
-- =====================================================================
-- Makes promote_to_agency_owner idempotent for re-promotion.
--
-- THE PROBLEM:
--   Migration 38 demotes by suspending the agency (status='suspended')
--   and clearing the user's role — the agency row itself is kept for
--   audit. If the admin then tries to re-promote that same user the
--   old function blocked with "User already owns an agency" because of
--   `EXISTS (SELECT 1 FROM agencies WHERE owner_id = p_user_id)`.
--
-- THE NEW BEHAVIOUR:
--   * No agency at all     -> create one (unchanged).
--   * Suspended agency     -> reactivate it (status='verified'). Code
--                             and name update if a different value is
--                             passed; otherwise the historical values
--                             stay. All past members, payouts and
--                             transactions remain linked.
--   * Verified agency      -> still blocked, that user is actively an
--                             owner.
--
-- Code uniqueness still enforced — but the user's OWN suspended
-- agency is excluded so re-promoting with the same code Just Works.
--
-- Idempotent: re-runnable.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.promote_to_agency_owner(
  p_admin_id      UUID,
  p_user_id       UUID,
  p_proposed_code TEXT,
  p_proposed_name TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user            public.profiles%ROWTYPE;
  v_agency_id       UUID;
  v_existing_id     UUID;
  v_existing_status TEXT;
  v_name            TEXT;
  v_reactivated     BOOLEAN := FALSE;
BEGIN
  -- AuthZ.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_admin_id AND role IN ('admin', 'super_admin')
  ) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  SELECT * INTO v_user FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'User not found');
  END IF;

  -- Look up any agency owned by this user. There can be at most one.
  SELECT id, status
    INTO v_existing_id, v_existing_status
    FROM public.agencies
    WHERE owner_id = p_user_id
    LIMIT 1
    FOR UPDATE;

  -- An ACTIVE agency means they are already an owner.
  IF v_existing_id IS NOT NULL AND v_existing_status <> 'suspended' THEN
    RETURN json_build_object('success', false, 'message', 'User already owns an active agency');
  END IF;

  -- Validate code length.
  IF LENGTH(COALESCE(p_proposed_code, '')) < 3 THEN
    RETURN json_build_object('success', false, 'message', 'Agency code must be at least 3 characters');
  END IF;

  -- Code uniqueness — exclude the user's own suspended agency so the
  -- common "re-promote with the same code" case isn't a false collision.
  IF EXISTS (
    SELECT 1
      FROM public.agencies
     WHERE code = UPPER(p_proposed_code)
       AND (v_existing_id IS NULL OR id <> v_existing_id)
  ) THEN
    RETURN json_build_object('success', false, 'message', 'That agency code is already taken');
  END IF;

  v_name := COALESCE(NULLIF(TRIM(p_proposed_name), ''), v_user.full_name || '''s Agency');

  IF v_existing_id IS NOT NULL THEN
    -- Reactivate the suspended agency. Preserve diamond_balance, payout
    -- history, and the agency_id FK. Just flip status and refresh the
    -- code/name to whatever the admin entered.
    UPDATE public.agencies
       SET status = 'verified',
           code   = UPPER(p_proposed_code),
           name   = v_name
     WHERE id = v_existing_id;
    v_agency_id   := v_existing_id;
    v_reactivated := TRUE;
  ELSE
    -- Fresh promotion — same behaviour as before migration 38.
    INSERT INTO public.agencies (name, code, owner_id, status, payout_rate, host_conversion_rate)
    VALUES (v_name, UPPER(p_proposed_code), p_user_id, 'verified', 1150, 0.50)
    RETURNING id INTO v_agency_id;
  END IF;

  UPDATE public.profiles
     SET role = 'agency_owner'
   WHERE id = p_user_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (
    p_admin_id,
    CASE WHEN v_reactivated THEN 'reactivate_agency_owner' ELSE 'promote_agency_owner' END,
    'profile',
    p_user_id,
    jsonb_build_object(
      'agency_id',   v_agency_id,
      'code',        UPPER(p_proposed_code),
      'name',        v_name,
      'reactivated', v_reactivated
    )
  );

  RETURN json_build_object(
    'success',     true,
    'agency_id',   v_agency_id,
    'name',        v_name,
    'reactivated', v_reactivated,
    'message',     CASE
                     WHEN v_reactivated THEN 'Existing agency reactivated. History preserved.'
                     ELSE 'New agency created.'
                   END
  );
END $$;

GRANT EXECUTE ON FUNCTION public.promote_to_agency_owner(UUID, UUID, TEXT, TEXT) TO authenticated;