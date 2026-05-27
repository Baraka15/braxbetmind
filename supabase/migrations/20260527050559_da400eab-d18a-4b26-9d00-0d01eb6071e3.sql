
ALTER TABLE public.bets
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS actual_result text,
  ADD COLUMN IF NOT EXISTS pnl_units numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settled_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS bets_status_idx ON public.bets (status);
