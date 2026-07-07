
-- CLV tracking on bets
ALTER TABLE public.bets
  ADD COLUMN IF NOT EXISTS opening_pinn_price numeric,
  ADD COLUMN IF NOT EXISTS closing_pinn_price numeric,
  ADD COLUMN IF NOT EXISTS clv_pct numeric,
  ADD COLUMN IF NOT EXISTS sharpened_prob numeric,
  ADD COLUMN IF NOT EXISTS steam_flag boolean NOT NULL DEFAULT false;

-- Steam signals: log every detected steam move for auditability
CREATE TABLE IF NOT EXISTS public.steam_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id text NOT NULL,
  market text NOT NULL,
  selection text NOT NULL,
  sharp_move_pct numeric NOT NULL,     -- pinnacle opening→current % move toward this side
  soft_move_pct numeric NOT NULL,      -- avg soft-book move toward this side
  divergence numeric NOT NULL,         -- sharp - soft (positive = sharps leading against public)
  sharp_fair_prob numeric NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.steam_signals TO authenticated;
GRANT ALL ON public.steam_signals TO service_role;
ALTER TABLE public.steam_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read steam_signals" ON public.steam_signals FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS steam_signals_detected_at_idx ON public.steam_signals (detected_at DESC);
CREATE INDEX IF NOT EXISTS steam_signals_match_idx ON public.steam_signals (match_id);

-- Performance metrics rollup (daily), refreshed by refresh cron
CREATE TABLE IF NOT EXISTS public.performance_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  window_days int NOT NULL,
  market text NOT NULL,                -- 'all' or specific market key
  n_bets int NOT NULL,
  n_won int NOT NULL,
  roi_pct numeric NOT NULL,
  brier numeric NOT NULL,
  log_loss numeric NOT NULL,
  ece numeric NOT NULL,                -- expected calibration error
  avg_clv_pct numeric,
  hit_rate numeric NOT NULL
);
GRANT SELECT ON public.performance_metrics TO authenticated;
GRANT ALL ON public.performance_metrics TO service_role;
ALTER TABLE public.performance_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read perf metrics" ON public.performance_metrics FOR SELECT TO authenticated USING (true);
CREATE INDEX IF NOT EXISTS perf_metrics_computed_idx ON public.performance_metrics (computed_at DESC);
