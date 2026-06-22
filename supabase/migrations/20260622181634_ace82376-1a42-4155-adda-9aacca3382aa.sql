
-- API keys for third-party access
CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  rate_limit_per_min INT NOT NULL DEFAULT 60 CHECK (rate_limit_per_min BETWEEN 1 AND 600),
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO authenticated;
GRANT ALL ON public.api_keys TO service_role;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners manage their api keys"
  ON public.api_keys FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Atomic rate-limiter + key validator. Returns user_id if the request is allowed,
-- NULL if the key is missing/revoked or the per-minute quota is exhausted.
CREATE OR REPLACE FUNCTION public.consume_api_key(_hash TEXT, _now TIMESTAMPTZ DEFAULT now())
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.api_keys%ROWTYPE;
BEGIN
  SELECT * INTO rec FROM public.api_keys WHERE key_hash = _hash AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF _now - rec.window_start >= interval '1 minute' THEN
    UPDATE public.api_keys
      SET window_start = _now, request_count = 1, last_used_at = _now
      WHERE id = rec.id;
    RETURN rec.user_id;
  END IF;

  IF rec.request_count >= rec.rate_limit_per_min THEN
    RETURN NULL;
  END IF;

  UPDATE public.api_keys
    SET request_count = rec.request_count + 1, last_used_at = _now
    WHERE id = rec.id;
  RETURN rec.user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_api_key(TEXT, TIMESTAMPTZ) FROM public;
GRANT EXECUTE ON FUNCTION public.consume_api_key(TEXT, TIMESTAMPTZ) TO service_role;

-- Bet placement tracking
ALTER TABLE public.bets
  ADD COLUMN IF NOT EXISTS placed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS placed_stake NUMERIC,
  ADD COLUMN IF NOT EXISTS placed_odds NUMERIC,
  ADD COLUMN IF NOT EXISTS placement_note TEXT;
