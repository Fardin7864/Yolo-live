-- Put Teen Patti's exact 10-round outcome control behind one validated admin RPC.
-- Saving a changed configuration clears the remaining bag so the next paid
-- round begins a fresh cycle. The settlement function already ignores payout
-- targeting while this strategy is enabled.

UPDATE public.system_settings
   SET value = jsonb_build_object(
         'enabled', COALESCE((value->>'enabled')::BOOLEAN, FALSE),
         'cycle', 10,
         'max', 2,
         'medium', 3,
         'min', 5
       ),
       updated_at = NOW()
 WHERE key = 'tin_patti_pro_win_strategy'
   AND COALESCE((value->>'cycle')::INT, 10) = 10
   AND COALESCE((value->>'max')::INT, 2) = 2
   AND COALESCE((value->>'medium')::INT, 6) = 6
   AND COALESCE((value->>'min')::INT, 2) = 2;

INSERT INTO public.system_settings (key, value)
VALUES (
  'tin_patti_pro_win_strategy',
  '{"enabled":false,"cycle":10,"max":2,"medium":3,"min":5}'::JSONB
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.admin_update_tin_patti_win_strategy(
  p_enabled BOOLEAN,
  p_max INT,
  p_medium INT,
  p_min INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id UUID := auth.uid();
  v_config JSONB;
BEGIN
  IF v_admin_id IS NULL OR public.is_admin(v_admin_id) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Admin access required');
  END IF;

  IF p_max IS NULL OR p_medium IS NULL OR p_min IS NULL
     OR p_max < 0 OR p_medium < 0 OR p_min < 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Win counts must be 0 or greater');
  END IF;

  IF p_max + p_medium + p_min <> 10 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Win counts must add up to exactly 10');
  END IF;

  v_config := jsonb_build_object(
    'enabled', COALESCE(p_enabled, FALSE),
    'cycle', 10,
    'max', p_max,
    'medium', p_medium,
    'min', p_min
  );

  INSERT INTO public.system_settings (key, value, updated_at, updated_by)
  VALUES ('tin_patti_pro_win_strategy', v_config, NOW(), v_admin_id)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by;

  INSERT INTO public.tin_patti_pro_win_strategy_state (
    id, remaining, cycle_started_at, updated_at
  )
  VALUES (TRUE, '{}'::JSONB, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET remaining = '{}'::JSONB,
        cycle_started_at = NOW(),
        updated_at = NOW();

  INSERT INTO public.admin_audit_log (
    admin_id, action, target_type, target_id, payload
  )
  VALUES (
    v_admin_id,
    'update_tin_patti_win_strategy',
    'game_settings',
    NULL,
    v_config || jsonb_build_object('game_id', 'tin_patti_pro')
  );

  RETURN jsonb_build_object('success', TRUE, 'config', v_config, 'cycle_reset', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_tin_patti_win_strategy(BOOLEAN, INT, INT, INT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_tin_patti_win_strategy(BOOLEAN, INT, INT, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_update_tin_patti_win_strategy(BOOLEAN, INT, INT, INT) IS
  'Validates and saves Teen Patti exact 10-round win quotas, then starts a fresh cycle.';
