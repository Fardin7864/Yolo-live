-- =====================================================================
-- 21_room_blocks.sql — Permanent host-side blocks per room
-- =====================================================================
-- Replaces in-memory `blockedUsers` array in the broadcast screen with a
-- DB-persisted block list so a blocked user stays blocked even after the
-- host restarts the live (or the app process).
--
-- Each row = "host H has permanently blocked user B from their room."
-- The room id used by the live screen is the broadcaster's profile id,
-- so we key the block by `host_id` (the broadcaster).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.room_blocks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    blocked_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (host_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS room_blocks_host_idx    ON public.room_blocks (host_id);
CREATE INDEX IF NOT EXISTS room_blocks_blocked_idx ON public.room_blocks (blocked_id);

ALTER TABLE public.room_blocks ENABLE ROW LEVEL SECURITY;

-- Hosts can read their own block list.
DROP POLICY IF EXISTS "host reads own blocks" ON public.room_blocks;
CREATE POLICY "host reads own blocks" ON public.room_blocks
    FOR SELECT USING (auth.uid() = host_id);

-- The blocked user themselves can also read their own row (so the client
-- can pre-check before letting them open the room).
DROP POLICY IF EXISTS "blocked user reads own" ON public.room_blocks;
CREATE POLICY "blocked user reads own" ON public.room_blocks
    FOR SELECT USING (auth.uid() = blocked_id);

-- Hosts insert/delete their own blocks via dedicated RPCs (below) which
-- run as SECURITY DEFINER, so we lock direct INSERT/DELETE down.
DROP POLICY IF EXISTS "no direct write" ON public.room_blocks;
CREATE POLICY "no direct write" ON public.room_blocks
    FOR ALL USING (false) WITH CHECK (false);

-- =====================================================================
-- RPC: room_block_user(target uuid, reason text default null)
-- Caller (host) blocks `target` from their room.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.room_block_user(target uuid, reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF target = me THEN
    RAISE EXCEPTION 'Cannot block yourself';
  END IF;
  INSERT INTO public.room_blocks (host_id, blocked_id, reason)
  VALUES (me, target, reason)
  ON CONFLICT (host_id, blocked_id) DO UPDATE SET reason = EXCLUDED.reason;
END;
$$;

-- =====================================================================
-- RPC: room_unblock_user(target uuid)
-- Caller (host) removes `target` from their block list.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.room_unblock_user(target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  DELETE FROM public.room_blocks
    WHERE host_id = me AND blocked_id = target;
END;
$$;

-- =====================================================================
-- RPC: room_get_blocks(room_host uuid)
-- Returns the list of blocked user IDs for the given host. Open to the
-- host themselves (for management) and to anyone reading the room to
-- decide whether to deny entry.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.room_get_blocks(room_host uuid)
RETURNS TABLE (blocked_id uuid, name text, avatar text, reason text, created_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rb.blocked_id, p.full_name AS name, p.avatar_url AS avatar, rb.reason, rb.created_at
    FROM public.room_blocks rb
    LEFT JOIN public.profiles p ON p.id = rb.blocked_id
    WHERE rb.host_id = room_host
    ORDER BY rb.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.room_block_user(uuid, text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.room_unblock_user(uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.room_get_blocks(uuid)         TO authenticated;