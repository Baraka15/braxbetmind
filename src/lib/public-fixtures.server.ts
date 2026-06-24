import type { OddsApiEvent } from "./odds-api.server";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const FALLBACK_BOOKMAKER = "model-fixture-feed";

const ESPN_LEAGUES: Record<string, string[]> = {
  soccer_epl: ["eng.1"],
  soccer_spain_la_liga: ["esp.1"],
  soccer_italy_serie_a: ["ita.1"],
  soccer_germany_bundesliga: ["ger.1"],
  soccer_usa_mls: ["usa.1"],
  soccer_brazil_campeonato: ["bra.1"],
  soccer_mexico_ligamx: ["mex.1"],
  soccer_norway_eliteserien: ["nor.1"],
  soccer_sweden_allsvenskan: ["swe.1"],
  soccer_japan_j_league: ["jpn.1"],
  soccer_conmebol_copa_libertadores: ["conmebol.libertadores"],
  soccer_uefa_champs_league: ["uefa.champions"],
  soccer_fifa_world_cup: ["fifa.world"],
  soccer_fifa_club_world_cup: ["fifa.cwc"],
  soccer_concacaf_gold_cup: ["concacaf.gold"],
  soccer_ireland_premier: ["irl.1"],
  soccer_china_superleague: ["chn.1"],
  soccer_usa_nwsl: ["usa.nwsl"],
};

const GLOBAL_ESPN_SLUGS = [
  "fifa.world",
  "fifa.cwc",
  "concacaf.gold",
  "irl.1",
  "chn.1",
  "usa.1",
  "bra.1",
  "swe.1",
  "nor.1",
  "jpn.1",
  "mex.1",
  "usa.nwsl",
];

const SPORT_KEY_BY_ESPN = Object.fromEntries(
  Object.entries(ESPN_LEAGUES).flatMap(([sportKey, slugs]) => slugs.map((slug) => [slug, sportKey])),
) as Record<string, string>;

interface EspnEvent {
  id: string;
  date: string;
  name?: string;
  competitions?: Array<{
    status?: { type?: { name?: string; completed?: boolean } };
    competitors?: Array<{
      homeAway?: "home" | "away";
      team?: { displayName?: string; name?: string };
    }>;
  }>;
  league?: { name?: string };
}

interface EspnScoreboard {
  leagues?: Array<{ name?: string }>;
  events?: EspnEvent[];
}

export async function fetchPublicFixturesForLeague(sportKey: string, daysAhead = 7): Promise<OddsApiEvent[]> {
  const slugs = ESPN_LEAGUES[sportKey] ?? [];
  const batches = await Promise.all(slugs.map((slug) => fetchEspnSlug(slug, sportKey, daysAhead)));
  return dedupeEvents(batches.flat());
}

export async function fetchGlobalPublicFixtures(daysAhead = 7): Promise<OddsApiEvent[]> {
  const batches = await Promise.all(
    GLOBAL_ESPN_SLUGS.map((slug) => fetchEspnSlug(slug, SPORT_KEY_BY_ESPN[slug] ?? `soccer_${slug.replace(/\W+/g, "_")}`, daysAhead)),
  );
  return dedupeEvents(batches.flat());
}

async function fetchEspnSlug(slug: string, sportKey: string, daysAhead: number): Promise<OddsApiEvent[]> {
  const urls = [
    `${ESPN_BASE}/${slug}/scoreboard?limit=100`,
    `${ESPN_BASE}/${slug}/scoreboard?dates=${dateRange(daysAhead)}&limit=100`,
  ];
  const all: OddsApiEvent[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = (await res.json()) as EspnScoreboard;
      const leagueName = json.leagues?.[0]?.name ?? sportKey;
      for (const event of json.events ?? []) {
        const mapped = mapEspnEvent(event, sportKey, leagueName, daysAhead);
        if (mapped) all.push(mapped);
      }
    } catch (error) {
      console.warn(`public fixtures ${slug}:`, (error as Error).message);
    }
  }
  return all;
}

function mapEspnEvent(event: EspnEvent, sportKey: string, leagueName: string, daysAhead: number): OddsApiEvent | null {
  const competition = event.competitions?.[0];
  const kickoff = new Date(event.date).getTime();
  const hoursAhead = (kickoff - Date.now()) / 3_600_000;
  if (!Number.isFinite(kickoff) || hoursAhead < -2 || hoursAhead > daysAhead * 24) return null;
  if (competition?.status?.type?.completed) return null;

  const competitors = competition?.competitors ?? [];
  const home = competitors.find((team) => team.homeAway === "home")?.team;
  const away = competitors.find((team) => team.homeAway === "away")?.team;
  const homeName = home?.displayName ?? home?.name;
  const awayName = away?.displayName ?? away?.name;
  if (!homeName || !awayName) return null;

  return {
    id: `espn-${sportKey}-${event.id}`,
    sport_key: sportKey,
    sport_title: leagueName,
    commence_time: event.date,
    home_team: homeName,
    away_team: awayName,
    bookmakers: [{
      key: FALLBACK_BOOKMAKER,
      title: "Fixture model",
      last_update: new Date().toISOString(),
      markets: [{ key: "h2h", outcomes: [
        { name: homeName, price: 1.91 },
        { name: "Draw", price: 3.35 },
        { name: awayName, price: 3.95 },
      ] }],
    }],
  };
}

function dateRange(daysAhead: number) {
  const start = new Date();
  const end = new Date(Date.now() + daysAhead * 86_400_000);
  const fmt = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${fmt(start)}-${fmt(end)}`;
}

function dedupeEvents(events: OddsApiEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.home_team}|${event.away_team}|${event.commence_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}