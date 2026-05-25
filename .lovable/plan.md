# BetMind Pro — Build Plan

## Stack adaptation
Your spec calls for Next.js 14, but this project is TanStack Start (React 19 + Vite + Cloudflare Workers). I'll keep every requirement — only the framework names change:

| Spec | Implementation |
|---|---|
| Next.js App Router | TanStack Start file-based routes (`src/routes/`) |
| Next API routes | `createServerFn` + server routes under `/api/public/*` |
| Vercel Cron | Supabase `pg_cron` calling `/api/public/cron/refresh` |
| Supabase Auth/DB/Realtime | Lovable Cloud (= managed Supabase) |
| shadcn/ui + Tailwind + Recharts | Same |

## 1. Backend setup
- Enable Lovable Cloud.
- Request `ODDS_API_KEY` secret (The Odds API v4).
- Optional `PREDICTION_API_URL` secret — if unset, fallback Poisson model runs.

## 2. Database schema (migration)
- `profiles` — id, email, created_at (trigger auto-creates on signup).
- `user_settings` — user_id, bankroll, kelly_fraction (default 0.5), min_edge (0.02), max_stake_pct (0.05), max_daily_bets (10), tracked_leagues (text[]).
- `matches` — id (odds-api event id), sport_key, league, home, away, commence_time, status.
- `odds` — id, match_id, bookmaker, market, home_odds, draw_odds, away_odds, opening_home, opening_draw, opening_away, last_update.
- `predictions` — match_id (pk), p_home, p_draw, p_away, source, updated_at.
- `bets` — id, match_id, outcome, best_odds, bookmaker, ai_prob, implied_prob, edge_pct, kelly_stake, sharp_alert, created_at.
- `bankroll_history` — user_id, date, balance, pnl.
- RLS: profiles/settings/bankroll_history user-scoped; matches/odds/predictions/bets readable by authenticated users.

## 3. Service modules (`src/lib/`)
- `odds-api.server.ts` — fetch from The Odds API with exponential backoff. Sharp books: Pinnacle, Betfair, Circa.
- `prediction.server.ts` — calls external `PREDICTION_API_URL` or Poisson fallback (team strength from historical odds).
- `value-engine.server.ts` — overround removal (proportional), edge %, Kelly stake, sharp-money detection (>5% movement vs opening).
- `refresh.functions.ts` — orchestrates: fetch odds → upsert → predict → compute bets.

## 4. Server endpoints
- `createServerFn`: `getBets`, `getSharpAlerts`, `getUserSettings`, `updateSettings`, `getBankrollHistory`.
- Server route `POST /api/public/cron/refresh` — HMAC-signed, called every 60s by pg_cron.

## 5. Routes (UI)
- `/login`, `/signup`, `/reset-password` — email/password auth.
- `/_authenticated/dashboard` (main) — top bar (bankroll, daily P/L, settings), bets table, sharp money panel, bankroll chart, edge distribution chart. Realtime subscription on `bets`.
- `/_authenticated/settings` — Kelly fraction, min edge, max daily bets, leagues, bankroll.
- `/` — marketing landing → CTA to login.

## 6. Design
Dark sports-trading aesthetic: near-black bg, lime-green positive edges, red negatives, JetBrains Mono for odds, Inter for UI. Compact data-dense tables. Subtle pulse animation on sharp alerts. Audio cue (Web Audio API beep) when a new bet with edge > 5% arrives.

## 7. Out of scope for v1 (call out)
- Actual bet placement (button is a placeholder, per spec).
- Historical backtesting UI.
- Multi-sport (football only).
- pg_cron registration: I'll provide the SQL snippet but the user runs it once in the Cloud SQL editor since cron requires extension setup.

## Technical notes
- Supabase Realtime via `supabase.channel('bets').on('postgres_changes', ...)`.
- React Query for caching; 60s stale time on predictions.
- All odds processing server-side; client only renders.
- Rate limit handling: 429 → exponential backoff up to 3 retries.
- Sharp move flag computed in `value-engine` by comparing current Pinnacle vs `opening_*` columns.

After you approve, I'll: enable Cloud → request the Odds API key → write the migration → build services → build UI. Expect ~25-30 file edits in one pass.