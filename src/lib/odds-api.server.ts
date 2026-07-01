/**
 * The Odds API v4 integration.
 * Docs: https://the-odds-api.com/liveapi/guides/v4/
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const SHARP_BOOKMAKERS = ["pinnacle", "betfair_ex_eu", "betfair_ex_uk", "circasports"] as const;

export function isSharpBook(key: string): boolean {
  return (SHARP_BOOKMAKERS as readonly string[]).includes(key);
}

export interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}
export interface OddsApiMarket {
  key: string;
  outcomes: OddsApiOutcome[];
}
export interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}
export interface OddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

export interface OddsApiScore {
  id: string;
  sport_key: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: Array<{ name: string; score: string }> | null;
  last_update: string | null;
}

interface CachedMatchRow {
  id: string;
  sport_key: string;
  league: string | null;
  home: string;
  away: string;
  commence_time: string;
  odds: Array<{
    bookmaker: string;
    home_odds: number | null;
    draw_odds: number | null;
    away_odds: number | null;
    last_update: string;
  }> | null;
}

const BASE = "https://api.the-odds-api.com/v4";

async function fetchWithBackoff(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url);
  if (res.status === 429 && attempt < 3) {
    const wait = 500 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, wait));
    return fetchWithBackoff(url, attempt + 1);
  }
  return res;
}

/** Fetch upcoming events with H2H odds for a given soccer league. */
export async function fetchOddsForLeague(sportKey: string): Promise<OddsApiEvent[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY is not configured");

  const params = new URLSearchParams({
    apiKey,
    regions: "eu,uk,us",
    // Free/low-tier plans reject `btts` at this endpoint. Fetch the core
    // markets that every plan supports; BTTS is derived from Dixon-Coles.
    markets: "h2h,totals",
    oddsFormat: "decimal",
    dateFormat: "iso",
  });
  const url = `${BASE}/sports/${sportKey}/odds?${params}`;
  const res = await fetchWithBackoff(url);
  if (!res.ok) {
    const text = await res.text();
    // Some plans reject certain markets. Fall back to h2h-only.
    if (res.status === 422 || res.status === 400) {
      const fallback = new URLSearchParams({
        apiKey, regions: "eu,uk,us", markets: "h2h", oddsFormat: "decimal", dateFormat: "iso",
      });
      const r2 = await fetchWithBackoff(`${BASE}/sports/${sportKey}/odds?${fallback}`);
      if (r2.ok) return (await r2.json()) as OddsApiEvent[];
    }
    throw new Error(`Odds API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OddsApiEvent[];
}

/** Fetch live & recently-finished scores for a league (Odds API /scores endpoint).
 *  Used by the live-betting page to compute elapsed minutes + current score. */
export async function fetchScoresForLeague(sportKey: string, daysFrom = 1): Promise<OddsApiScore[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("ODDS_API_KEY is not configured");
  const params = new URLSearchParams({ apiKey, daysFrom: String(daysFrom), dateFormat: "iso" });
  const res = await fetchWithBackoff(`${BASE}/sports/${sportKey}/scores?${params}`);
  if (!res.ok) throw new Error(`scores ${sportKey} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as OddsApiScore[];
}

/** Rebuild upcoming events from stored odds when the live odds quota is empty. */
export async function loadCachedOddsForLeague(sportKey: string): Promise<OddsApiEvent[]> {
  const { data, error } = await supabaseAdmin
    .from("matches")
    .select("id, sport_key, league, home, away, commence_time, odds(bookmaker, home_odds, draw_odds, away_odds, last_update)")
    .eq("sport_key", sportKey)
    .gt("commence_time", new Date().toISOString())
    .order("commence_time", { ascending: true })
    .limit(80);

  if (error) throw new Error(`cached odds ${sportKey}: ${error.message}`);

  return ((data ?? []) as CachedMatchRow[])
    .map((m) => {
      const bookmakers = (m.odds ?? [])
        .filter((o) => o.home_odds && o.draw_odds && o.away_odds)
        .map((o) => ({
          key: o.bookmaker,
          title: o.bookmaker,
          last_update: o.last_update,
          markets: [{
            key: "h2h",
            outcomes: [
              { name: m.home, price: Number(o.home_odds) },
              { name: "Draw", price: Number(o.draw_odds) },
              { name: m.away, price: Number(o.away_odds) },
            ],
          }],
        }));

      return {
        id: m.id,
        sport_key: m.sport_key,
        sport_title: m.league ?? sportKey,
        commence_time: m.commence_time,
        home_team: m.home,
        away_team: m.away,
        bookmakers,
      } satisfies OddsApiEvent;
    })
    .filter((event) => event.bookmakers.length > 0);
}

/** Pick the best (highest) home/draw/away odds across the sharp books for an event. */
export function pickSharpOdds(event: OddsApiEvent) {
  const sharps = event.bookmakers.filter((b) => SHARP_BOOKMAKERS.includes(b.key as never));
  const pool = sharps.length > 0 ? sharps : event.bookmakers; // fallback to any book
  const best: { home?: { price: number; book: string }; draw?: { price: number; book: string }; away?: { price: number; book: string } } = {};
  for (const bk of pool) {
    const market = bk.markets.find((m) => m.key === "h2h");
    if (!market) continue;
    for (const out of market.outcomes) {
      let key: "home" | "draw" | "away" | null = null;
      if (out.name === event.home_team) key = "home";
      else if (out.name === event.away_team) key = "away";
      else if (out.name.toLowerCase() === "draw") key = "draw";
      if (!key) continue;
      const current = best[key];
      if (!current || out.price > current.price) {
        best[key] = { price: out.price, book: bk.title };
      }
    }
  }
  return best;
}
