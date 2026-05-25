
-- ============ profiles ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- trigger to auto-create profile + default settings
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email);
  INSERT INTO public.user_settings (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

-- ============ user_settings ============
CREATE TABLE public.user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  bankroll NUMERIC NOT NULL DEFAULT 1000,
  kelly_fraction NUMERIC NOT NULL DEFAULT 0.5,
  min_edge NUMERIC NOT NULL DEFAULT 0.02,
  max_stake_pct NUMERIC NOT NULL DEFAULT 0.05,
  max_daily_bets INT NOT NULL DEFAULT 10,
  tracked_leagues TEXT[] NOT NULL DEFAULT ARRAY['soccer_epl','soccer_uefa_champs_league','soccer_spain_la_liga','soccer_italy_serie_a','soccer_germany_bundesliga'],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own settings all" ON public.user_settings FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ matches ============
CREATE TABLE public.matches (
  id TEXT PRIMARY KEY,
  sport_key TEXT NOT NULL,
  league TEXT,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  commence_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read matches" ON public.matches FOR SELECT TO authenticated USING (true);
CREATE INDEX idx_matches_commence ON public.matches(commence_time);

-- ============ odds ============
CREATE TABLE public.odds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id TEXT NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  bookmaker TEXT NOT NULL,
  home_odds NUMERIC,
  draw_odds NUMERIC,
  away_odds NUMERIC,
  opening_home NUMERIC,
  opening_draw NUMERIC,
  opening_away NUMERIC,
  last_update TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, bookmaker)
);
ALTER TABLE public.odds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read odds" ON public.odds FOR SELECT TO authenticated USING (true);
CREATE INDEX idx_odds_match ON public.odds(match_id);

-- ============ predictions ============
CREATE TABLE public.predictions (
  match_id TEXT PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  p_home NUMERIC NOT NULL,
  p_draw NUMERIC NOT NULL,
  p_away NUMERIC NOT NULL,
  source TEXT NOT NULL DEFAULT 'poisson',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read predictions" ON public.predictions FOR SELECT TO authenticated USING (true);

-- ============ bets ============
CREATE TABLE public.bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id TEXT NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('home','draw','away')),
  best_odds NUMERIC NOT NULL,
  bookmaker TEXT NOT NULL,
  ai_prob NUMERIC NOT NULL,
  implied_prob NUMERIC NOT NULL,
  edge_pct NUMERIC NOT NULL,
  kelly_stake_pct NUMERIC NOT NULL,
  sharp_alert BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, outcome)
);
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read bets" ON public.bets FOR SELECT TO authenticated USING (true);
CREATE INDEX idx_bets_edge ON public.bets(edge_pct DESC);
ALTER PUBLICATION supabase_realtime ADD TABLE public.bets;
ALTER TABLE public.bets REPLICA IDENTITY FULL;

-- ============ bankroll_history ============
CREATE TABLE public.bankroll_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  balance NUMERIC NOT NULL,
  pnl NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);
ALTER TABLE public.bankroll_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own bankroll all" ON public.bankroll_history FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
