-- Hermes Terminal storage, isolated from other Supabase app tables.
-- Run once in the restored supabase-violet-zebra project's SQL Editor.
-- No account initialization, deletes, billing changes, or existing-table modifications.
BEGIN;
CREATE TABLE IF NOT EXISTS public.hermes_kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.hermes_events (
  day text NOT NULL,
  seq bigint NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (day, seq)
);
ALTER TABLE public.hermes_kv ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hermes_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hermes_kv, public.hermes_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hermes_kv, public.hermes_events TO service_role;

-- All operations are service-role-only and run as caller, not schema owner.
-- This RPC supports fenced account commits and shared request pacing.
CREATE OR REPLACE FUNCTION public.hermes_storage(p_op text, p_key text DEFAULT '', p_value jsonb DEFAULT NULL, p_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.hermes_kv%ROWTYPE;
  v_state jsonb;
  v_event jsonb;
  v_count integer;
  v_result jsonb;
  v_expires timestamptz;
BEGIN
  IF p_op = 'get' THEN
    SELECT * INTO v_row FROM public.hermes_kv
    WHERE key = p_key AND (expires_at IS NULL OR expires_at > clock_timestamp());
    RETURN v_row.value;
  ELSIF p_op = 'set' THEN
    IF p_options ? 'px' THEN
      v_expires := clock_timestamp() + ((p_options->>'px')::bigint * interval '1 millisecond');
    END IF;
    IF coalesce((p_options->>'nx')::boolean, false) THEN
      INSERT INTO public.hermes_kv AS k (key, value, expires_at)
      VALUES (p_key, p_value, v_expires)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
      WHERE k.expires_at IS NOT NULL AND k.expires_at <= clock_timestamp();
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count = 0 THEN RETURN 'null'::jsonb; END IF;
    ELSE
      INSERT INTO public.hermes_kv (key, value, expires_at) VALUES (p_key, p_value, v_expires)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;
    END IF;
    RETURN '"OK"'::jsonb;
  ELSIF p_op = 'release' THEN
    DELETE FROM public.hermes_kv WHERE key = p_key AND value = p_value;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN to_jsonb(v_count);
  ELSIF p_op = 'commit' THEN
    SELECT * INTO v_row FROM public.hermes_kv WHERE key = p_key FOR UPDATE;
    IF NOT FOUND OR v_row.value <> (p_options->'owner') OR v_row.expires_at <= clock_timestamp() THEN
      RETURN '0'::jsonb;
    END IF;
    v_state := p_value;
    -- Store each event once, independent of recent terminal history trimming.
    FOR v_event IN SELECT value FROM jsonb_array_elements(coalesce(p_options->'events', '[]'::jsonb)) LOOP
      INSERT INTO public.hermes_events(day, seq, event)
      VALUES (v_event->>'day', (v_event->'event'->>'seq')::bigint, v_event->'event')
      ON CONFLICT (day, seq) DO NOTHING;
    END LOOP;
    INSERT INTO public.hermes_kv(key, value, expires_at)
    VALUES (p_options->>'stateKey', v_state, NULL)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL;
    DELETE FROM public.hermes_kv WHERE key = p_key;
    RETURN '1'::jsonb;
  ELSIF p_op = 'history' THEN
    SELECT coalesce(jsonb_agg(t.event ORDER BY t.seq), '[]'::jsonb) INTO v_result
    FROM (SELECT seq, event FROM public.hermes_events WHERE day = p_key ORDER BY seq
      LIMIT least(101, greatest(1, coalesce((p_options->>'limit')::integer, 101)))
      OFFSET greatest(0, coalesce((p_options->>'offset')::integer, 0))) t;
    RETURN v_result;
  ELSE
    RAISE EXCEPTION 'Unsupported Hermes storage operation';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hermes_storage(text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_storage(text, text, jsonb, jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
