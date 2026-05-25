/**
 * Elo ratings layer. Updates from real results, persists to team_ratings.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadResultsFromDb } from "./football-data.server";

const K = 24; // Elo K-factor for football
const HOME_ADV = 65; // Elo points
const DEFAULT_ELO = 1500;

/** Win expectancy for home team using Elo with home advantage. */
export function eloExpected(eloHome: number, eloAway: number): number {
  const diff = eloHome + HOME_ADV - eloAway;
  return 1 / (1 + Math.pow(10, -diff / 400));
}

/** Recompute Elo for a sport from its match history (chronological). */
export async function rebuildEloForSport(sportKey: string): Promise<Map<string, number>> {
  const results = await loadResultsFromDb(sportKey, 500);
  // ascending order for sequential update
  results.sort((a, b) => +new Date(a.played_at) - +new Date(b.played_at));

  const ratings = new Map<string, number>();
  const lastPlayed = new Map<string, string>();
  const counts = new Map<string, number>();

  for (const r of results) {
    const eh = ratings.get(r.home_team) ?? DEFAULT_ELO;
    const ea = ratings.get(r.away_team) ?? DEFAULT_ELO;
    const expectedH = eloExpected(eh, ea);
    let actualH: number;
    if (r.home_goals > r.away_goals) actualH = 1;
    else if (r.home_goals < r.away_goals) actualH = 0;
    else actualH = 0.5;
    // Goal-margin multiplier (FiveThirtyEight style)
    const margin = Math.abs(r.home_goals - r.away_goals);
    const mult = Math.log(Math.max(margin, 1) + 1) * (2.2 / ((Math.abs((eh + HOME_ADV) - ea) * 0.001) + 2.2));
    const delta = K * mult * (actualH - expectedH);
    ratings.set(r.home_team, eh + delta);
    ratings.set(r.away_team, ea - delta);
    lastPlayed.set(r.home_team, r.played_at);
    lastPlayed.set(r.away_team, r.played_at);
    counts.set(r.home_team, (counts.get(r.home_team) ?? 0) + 1);
    counts.set(r.away_team, (counts.get(r.away_team) ?? 0) + 1);
  }

  // Persist
  if (ratings.size) {
    const rows = [...ratings.entries()].map(([team_name, elo]) => ({
      team_name,
      sport_key: sportKey,
      elo,
      matches_played: counts.get(team_name) ?? 0,
      last_match_at: lastPlayed.get(team_name) ?? null,
      updated_at: new Date().toISOString(),
    }));
    await supabaseAdmin.from("team_ratings").upsert(rows, { onConflict: "team_name,sport_key" });
  }

  return ratings;
}

/** Convert Elo win-prob into a 1X2 distribution by carving out a draw share. */
export function eloTo1x2(pHomeWin: number): { home: number; draw: number; away: number } {
  // Draw share grows when teams are close.
  const closeness = 1 - Math.abs(pHomeWin - 0.5) * 2; // 0..1, 1 = equal teams
  const pDraw = 0.18 + 0.14 * closeness; // 18%..32%
  const remaining = 1 - pDraw;
  // Re-scale pHomeWin against the away "would have won" complement.
  const pHome = pHomeWin * remaining;
  const pAway = (1 - pHomeWin) * remaining;
  return { home: pHome, draw: pDraw, away: pAway };
}

const eloCache = new Map<string, { at: number; map: Map<string, number> }>();
const ELO_TTL = 30 * 60 * 1000;

export async function getEloMap(sportKey: string): Promise<Map<string, number>> {
  const cached = eloCache.get(sportKey);
  if (cached && Date.now() - cached.at < ELO_TTL) return cached.map;
  const map = await rebuildEloForSport(sportKey);
  eloCache.set(sportKey, { at: Date.now(), map });
  return map;
}