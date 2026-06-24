/**
 * football-data.org integration (free tier).
 * Returns finished/upcoming matches for a competition so we can feed Elo,
 * Dixon-Coles, form, and the fixture fallback when the odds quota is empty.
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

export interface FdFixture {
  id: number;
  utcDate: string;
  status: string;
  competition: { code: string; name: string };
  homeTeam: { name: string };
  awayTeam: { name: string };
}

const fetchCache = new Map<string, { at: number; data: FdMatch[] }>();
const fixtureCache = new Map<string, { at: number; data: FdFixture[] }>();
const TTL = 30 * 60 * 1000; // 30 min

export function sportKeyForFdCompetition(code: string): string | undefined {
  return Object.entries(FD_COMPETITION).find(([, fdCode]) => fdCode === code)?.[0];
}

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

export async function fetchUpcomingMatches(sportKey: string, daysAhead = 7): Promise<FdFixture[]> {
  const code = FD_COMPETITION[sportKey];
  if (!code) return [];
  const matches = await fetchUpcomingByUrl(
    `competition:${code}:${daysAhead}`,
    `${FD_BASE}/competitions/${code}/matches?${dateRangeParams(daysAhead)}`,
  );
  return matches.filter((m) => isFutureFixture(m));
}

export async function fetchGlobalUpcomingMatches(daysAhead = 7): Promise<FdFixture[]> {
  const matches = await fetchUpcomingByUrl(
    `global:${daysAhead}`,
    `${FD_BASE}/matches?${dateRangeParams(daysAhead)}`,
  );
  return matches.filter((m) => isFutureFixture(m) && sportKeyForFdCompetition(m.competition.code));
}

async function fetchUpcomingByUrl(cacheKey: string, url: string): Promise<FdFixture[]> {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) return [];

  const cached = fixtureCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL) return cached.data;

  const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
  if (!res.ok) {
    console.warn(`football-data fixtures ${cacheKey}: ${res.status}`);
    return cached?.data ?? [];
  }
  const json = (await res.json()) as { matches: FdFixture[] };
  const matches = json.matches ?? [];
  fixtureCache.set(cacheKey, { at: Date.now(), data: matches });
  return matches;
}

function dateRangeParams(daysAhead: number) {
  const dateFrom = new Date();
  const dateTo = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return new URLSearchParams({
    dateFrom: dateFrom.toISOString().slice(0, 10),
    dateTo: dateTo.toISOString().slice(0, 10),
  }).toString();
}

function isFutureFixture(match: FdFixture) {
  const kickoff = new Date(match.utcDate).getTime();
  return kickoff > Date.now() - 30 * 60 * 1000 && ["SCHEDULED", "TIMED"].includes(match.status);
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