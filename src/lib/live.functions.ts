import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { expectedLambdas, fitDixonColes } from "./dixon-coles.server";
import { fetchScoresForLeague, type OddsApiScore } from "./odds-api.server";
import { liveMarkets, liveScoreMatrix, topCorrectScores, type LiveSnapshot } from "./live.server";
import { MARKET_LABEL, SELECTION_LABEL, type MarketKey } from "./markets.server";

const DEFAULT_LEAGUES = [
  "soccer_epl", "soccer_uefa_champs_league", "soccer_spain_la_liga",
  "soccer_italy_serie_a", "soccer_germany_bundesliga", "soccer_usa_mls",
];

export interface LiveValueBet {
  matchId: string;
  league: string;
  home: string;
  away: string;
  minute: number;
  scoreHome: number;
  scoreAway: number;
  market: MarketKey;
  marketLabel: string;
  selection: string;
  selectionLabel: string;
  modelProb: number;
  bestOdds: number;
  bookmaker: string;
  evPct: number;
  topScores: Array<{ home: number; away: number; prob: number }>;
}

/** Returns the current live in-play board with Bayesian-updated EV per market. */
export const getLiveValueBets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ leagues: z.array(z.string().min(1).max(64)).max(20).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const leagues = data.leagues?.length ? data.leagues : DEFAULT_LEAGUES;
    const bets: LiveValueBet[] = [];
    const errors: string[] = [];

    for (const league of leagues) {
      let scores: OddsApiScore[] = [];
      try { scores = await fetchScoresForLeague(league, 1); }
      catch (e) { errors.push(`${league}: ${(e as Error).message}`); continue; }

      const liveScores = scores.filter((s) => !s.completed && s.scores && s.scores.length > 0);
      if (!liveScores.length) continue;

      // Pull stored odds for these matches (most recent snapshot).
      const ids = liveScores.map((s) => s.id);
      const { data: oddsRows } = await supabaseAdmin
        .from("odds")
        .select("match_id, bookmaker, home_odds, draw_odds, away_odds")
        .in("match_id", ids);

      const oddsByMatch = new Map<string, Array<{ book: string; home: number; draw: number; away: number }>>();
      for (const r of oddsRows ?? []) {
        if (!r.home_odds || !r.draw_odds || !r.away_odds) continue;
        const arr = oddsByMatch.get(r.match_id) ?? [];
        arr.push({ book: r.bookmaker, home: Number(r.home_odds), draw: Number(r.draw_odds), away: Number(r.away_odds) });
        oddsByMatch.set(r.match_id, arr);
      }

      const dc = await fitDixonColes(league);

      for (const s of liveScores) {
        const sH = Number(s.scores!.find((x) => x.name === s.home_team)?.score ?? 0);
        const sA = Number(s.scores!.find((x) => x.name === s.away_team)?.score ?? 0);
        const elapsedMs = Date.now() - new Date(s.commence_time).getTime();
        const minute = Math.max(0, Math.min(95, Math.round(elapsedMs / 60_000)));

        const { lh, la } = expectedLambdas(dc, s.home_team, s.away_team);
        const snap: LiveSnapshot = { minutesElapsed: minute, homeGoals: sH, awayGoals: sA };
        const post = liveScoreMatrix({ lh, la }, snap);
        const markets = liveMarkets(post);
        const top = topCorrectScores(post, 5);

        const books = oddsByMatch.get(s.id) ?? [];
        if (!books.length) continue;
        const best: Record<"home" | "draw" | "away", { price: number; book: string } | undefined> = {
          home: undefined, draw: undefined, away: undefined,
        };
        for (const b of books) {
          for (const k of ["home", "draw", "away"] as const) {
            if (!best[k] || b[k] > best[k]!.price) best[k] = { price: b[k], book: b.book };
          }
        }

        const h2h = markets.find((m) => m.market === "h2h")!;
        let pick: LiveValueBet | null = null;
        for (const k of ["home", "draw", "away"] as const) {
          const b = best[k];
          if (!b) continue;
          const p = h2h.selections[k];
          const ev = p * b.price - 1;
          if (!pick || ev > pick.evPct) {
            pick = {
              matchId: s.id, league, home: s.home_team, away: s.away_team,
              minute, scoreHome: sH, scoreAway: sA,
              market: "h2h", marketLabel: MARKET_LABEL.h2h,
              selection: k, selectionLabel: SELECTION_LABEL[k] ?? k,
              modelProb: p, bestOdds: b.price, bookmaker: b.book,
              evPct: ev, topScores: top,
            };
          }
        }
        if (pick) bets.push(pick);
      }
    }

    bets.sort((a, b) => b.evPct - a.evPct);
    return { bets, errors, generatedAt: new Date().toISOString() };
  });
