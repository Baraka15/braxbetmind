/**
 * The Odds API v4 integration.
 * Docs: https://the-odds-api.com/liveapi/guides/v4/
 */

export const SHARP_BOOKMAKERS = ["pinnacle", "betfair_ex_eu", "betfair_ex_uk", "circasports"] as const;

export function isSharpBook(key: string): boolean {
  return (SHARP_BOOKMAKERS as readonly string[]).includes(key);
}

export interface OddsApiOutcome {
  name: string;
  price: number;
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
    markets: "h2h,totals,btts",
    oddsFormat: "decimal",
    dateFormat: "iso",
  });
  const url = `${BASE}/sports/${sportKey}/odds?${params}`;
  const res = await fetchWithBackoff(url);
  if (!res.ok) {
    const text = await res.text();
    // Some plans don't allow `btts` — retry without it gracefully.
    if (res.status === 422 || res.status === 400) {
      const fallback = new URLSearchParams({
        apiKey, regions: "eu,uk,us", markets: "h2h,totals", oddsFormat: "decimal", dateFormat: "iso",
      });
      const r2 = await fetchWithBackoff(`${BASE}/sports/${sportKey}/odds?${fallback}`);
      if (r2.ok) return (await r2.json()) as OddsApiEvent[];
    }
    throw new Error(`Odds API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OddsApiEvent[];
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
