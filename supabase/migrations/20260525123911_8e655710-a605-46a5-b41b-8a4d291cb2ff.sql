
-- 1. Extend bets table with market metadata
ALTER TABLE public.bets
  ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'h2h',
  ADD COLUMN IF NOT EXISTS selection text,
  ADD COLUMN IF NOT EXISTS confidence_tier text NOT NULL DEFAULT 'B',
  ADD COLUMN IF NOT EXISTS rationale text,
  ADD COLUMN IF NOT EXISTS model_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS consensus_prob numeric;

-- Backfill selection from outcome for existing rows
UPDATE public.bets SET selection = outcome WHERE selection IS NULL;

-- Drop old uniqueness (match_id, outcome) if present, add new
ALTER TABLE public.bets DROP CONSTRAINT IF EXISTS bets_match_id_outcome_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bets_match_market_selection_key'
  ) THEN
    ALTER TABLE public.bets
      ADD CONSTRAINT bets_match_market_selection_key UNIQUE (match_id, market, selection);
  END IF;
END $$;

-- 2. Team Elo ratings
CREATE TABLE IF NOT EXISTS public.team_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_name text NOT NULL,
  sport_key text NOT NULL,
  elo numeric NOT NULL DEFAULT 1500,
  matches_played integer NOT NULL DEFAULT 0,
  last_match_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_name, sport_key)
);

ALTER TABLE public.team_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read team_ratings" ON public.team_ratings
  FOR SELECT TO authenticated USING (true);

-- 3. Cached historical match results
CREATE TABLE IF NOT EXISTS public.match_results (
  id text PRIMARY KEY,
  sport_key text NOT NULL,
  competition text,
  home_team text NOT NULL,
  away_team text NOT NULL,
  home_goals integer NOT NULL,
  away_goals integer NOT NULL,
  played_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'football-data',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_results_team_date
  ON public.match_results (home_team, away_team, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_results_sport_date
  ON public.match_results (sport_key, played_at DESC);

ALTER TABLE public.match_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read match_results" ON public.match_results
  FOR SELECT TO authenticated USING (true);
