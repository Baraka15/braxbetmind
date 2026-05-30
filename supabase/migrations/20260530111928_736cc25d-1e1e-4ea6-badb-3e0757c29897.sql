ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS last_telegram_alert_at timestamptz;