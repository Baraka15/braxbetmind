ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS telegram_chat_id text,
  ADD COLUMN IF NOT EXISTS telegram_min_edge numeric NOT NULL DEFAULT 0.05;