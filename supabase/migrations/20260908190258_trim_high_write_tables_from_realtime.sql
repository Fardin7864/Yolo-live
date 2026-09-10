-- Back the two write-heaviest tables out of the realtime publication.
--
-- Restoring the publication fixed the real bug (profiles was not replicated, so
-- balances never updated live). But it also added live_streams and
-- user_task_progress -- by far the busiest tables in the database -- to logical
-- decoding. Every row change in them is now decoded and evaluated against every
-- subscriber, and the home feed subscribes to live_streams unfiltered, so one
-- room update fans out to every user on the Home tab.
--
-- Neither table was replicated before, so removing them restores the previous
-- behaviour and costs nothing that was working yesterday. profiles stays, which
-- is the one that actually fixes coins landing during a live.
--
-- To put either back:  ALTER PUBLICATION supabase_realtime ADD TABLE public.x;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['live_streams', 'user_task_progress'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', v_table);
      RAISE NOTICE 'dropped % from supabase_realtime', v_table;
    END IF;
  END LOOP;
END $$;
