-- Let verified agency owners see applications sent to their agency and
-- notify the owner whenever a new application is created.

DROP POLICY IF EXISTS agency_join_requests_own_read ON public.agency_join_requests;
CREATE POLICY agency_join_requests_own_read ON public.agency_join_requests
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_live_staff(auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.agencies a
      WHERE a.id = agency_join_requests.agency_id
        AND a.owner_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.notify_agency_owner_of_join_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id UUID;
  v_agency_name TEXT;
  v_applicant_name TEXT;
BEGIN
  SELECT owner_id, name
    INTO v_owner_id, v_agency_name
  FROM public.agencies
  WHERE id = NEW.agency_id;

  SELECT COALESCE(NULLIF(BTRIM(full_name), ''), 'A user')
    INTO v_applicant_name
  FROM public.profiles
  WHERE id = NEW.user_id;

  IF v_owner_id IS NOT NULL AND v_owner_id <> NEW.user_id THEN
    INSERT INTO public.notifications(user_id, type, title, body, payload)
    VALUES (
      v_owner_id,
      'agency_join_request',
      'New agency join request',
      COALESCE(v_applicant_name, 'A user') || ' requested to join ' || COALESCE(v_agency_name, 'your agency'),
      jsonb_build_object(
        'request_id', NEW.id,
        'agency_id', NEW.agency_id,
        'applicant_id', NEW.user_id,
        'route', '/main/agency'
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agency_join_request_notify_owner ON public.agency_join_requests;
CREATE TRIGGER agency_join_request_notify_owner
  AFTER INSERT ON public.agency_join_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_agency_owner_of_join_request();

GRANT SELECT ON public.agency_join_requests TO authenticated;

