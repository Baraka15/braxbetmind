/**
 * football-data.org integration (free tier).
 * Returns finished matches for a competition so we can feed Elo + Dixon-Coles.
 * Free tier: 10 req/min, top European competitions only.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const FD_BASE = "https://api.football-data.org/v4";

/** Map The-Odds-API sport_key → football-data competition code. */
export const FD_COMPETITION: Record<string, string> = {
  soccer_epl: "PL",
  soccer_uefa_champs_league: "CL",
  soccer_spain_la_liga: "PD",
  soccer_italy_serie_a: "SA",
  soccer_germany_bundesliga: "BL1",
  soccer_france_ligue_one: "FL1",
  soccer_netherlands_eredivisie: "DED",
  soccer_portugal_primeira_liga: "PPL",
  soccer_brazil_campeonato: "BSA",
  soccer_conmebol_copa_libertadores: "CLI",
  soccer_uefa_european_championship: "EC",
  soccer_fifa_world_cup: "WC",
};

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  competition: { code: string; name: string };
  homeTeam: { name: string };
  awayTeam: { name: string };
  score: { fullTime: { home: number | null; away: number | null } };
}

const fetchCache = new Map<string, { at: number; data: FdMatch[] }>();
const TTL = 30 * 60 * 1000; // 30 min

export async function fetchFinishedMatches(sportKey: string): Promise<FdMatch[]> {
  const code = FD_COMPETITION[sportKey];
  if (!code) return [];
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) return [];

  const cached = fetchCache.get(code);
  if (cached && Date.now() - cached.at < TTL) return cached.data;

  // Pull the last ~120 days of finished matches
  const dateTo = new Date();
  const dateFrom = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const url = `${FD_BASE}/competitions/${code}/matches?status=FINISHED&dateFrom=${dateFrom.toISOString().slice(0, 10)}&dateTo=${dateTo.toISOString().slice(0, 10)}`;
  const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
  if (!res.ok) {
    console.warn(`football-data ${code}: ${res.status}`);
    return cached?.data ?? [];
  }
  const json = (await res.json()) as { matches: FdMatch[] };
  const matches = json.matches ?? [];
  fetchCache.set(code, { at: Date.now(), data: matches });

  // Persist to match_results for cross-session use
  if (matches.length) {
    const rows = matches
      .filter((m) => m.score.fullTime.home != null && m.score.fullTime.away != null)
      .map((m) => ({
        id: `fd-${m.id}`,
        sport_key: sportKey,
        competition: m.competition.name,
        home_team: m.homeTeam.name,
        away_team: m.awayTeam.name,
        home_goals: m.score.fullTime.home!,
        away_goals: m.score.fullTime.away!,
        played_at: m.utcDate,
        source: "football-data",
      }));
    if (rows.length) {
      await supabaseAdmin.from("match_results").upsert(rows, { onConflict: "id" });
    }
  }

  return matches;
}

/** Read finished matches for a sport from our cache table — works even when API key missing. */
export async function loadResultsFromDb(sportKey: string, limit = 300) {
  const { data, error } = await supabaseAdmin
    .from("match_results")
    .select("home_team, away_team, home_goals, away_goals, played_at")
    .eq("sport_key", sportKey)
    .order("played_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("loadResultsFromDb:", error.message);
    return [];
  }
  return data ?? [];
}