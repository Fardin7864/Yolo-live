-- Mirror of supabase/migrations/20260826010000_greedy_king_safe_bet_commit_window.sql
UPDATE public.game_settings
   SET special_result_rules = jsonb_set(
         COALESCE(special_result_rules, '{}'::JSONB),
         '{bet_acceptance_grace_s}',
         '5'::JSONB,
         TRUE
       ),
       updated_at = NOW()
 WHERE id = 'greedy_pro';
