import type { OddsApiBookmaker, OddsApiEvent } from "./odds-api.server";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_DROPDOWN = "https://site.web.api.espn.com/apis/site/v2/leagues/dropdown?sport=soccer&limit=500";
const SPORTSDB_BASE = "https://www.thesportsdb.com/api/v1/json/3";
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

/** Curated seed list — used as a hard-coded fallback if the dropdown call
 *  fails. `fetchGlobalPublicFixtures` prefers the live-discovered catalogue. */
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

/** Live-discovered ESPN soccer league catalog, cached in-memory for 6h. */
let espnCatalogCache: { slugs: string[]; expires: number } | null = null;

async function discoverEspnSoccerSlugs(): Promise<string[]> {
  if (espnCatalogCache && espnCatalogCache.expires > Date.now()) {
    return espnCatalogCache.slugs;
  }
  try {
    const res = await fetch(ESPN_DROPDOWN);
    if (!res.ok) throw new Error(`espn dropdown ${res.status}`);
    const json = (await res.json()) as { leagues?: Array<{ slug?: string }> };
    const slugs = (json.leagues ?? []).map((l) => l.slug).filter((s): s is string => Boolean(s));
    if (slugs.length < 10) throw new Error("dropdown too small");
    espnCatalogCache = { slugs, expires: Date.now() + 6 * 3_600_000 };
    return slugs;
  } catch (error) {
    console.warn("espn catalog discovery:", (error as Error).message);
    return GLOBAL_ESPN_SLUGS;
  }
}

/** TheSportsDB soccer league catalog, cached in-memory for 24h. */
let sportsDbCatalogCache: { leagues: Array<{ id: string; name: string }>; expires: number } | null = null;

async function discoverSportsDbLeagues(): Promise<Array<{ id: string; name: string }>> {
  if (sportsDbCatalogCache && sportsDbCatalogCache.expires > Date.now()) {
    return sportsDbCatalogCache.leagues;
  }
  try {
    const res = await fetch(`${SPORTSDB_BASE}/all_leagues.php`);
    if (!res.ok) throw new Error(`sportsdb ${res.status}`);
    const json = (await res.json()) as { leagues?: Array<{ idLeague?: string; strLeague?: string; strSport?: string }> };
    const leagues = (json.leagues ?? [])
      .filter((l) => l.strSport === "Soccer" && l.idLeague && l.strLeague)
      .map((l) => ({ id: l.idLeague as string, name: l.strLeague as string }));
    sportsDbCatalogCache = { leagues, expires: Date.now() + 24 * 3_600_000 };
    return leagues;
  } catch (error) {
    console.warn("sportsdb catalog:", (error as Error).message);
    return [];
  }
}

interface SportsDbEvent {
  idEvent: string;
  strEvent?: string;
  strHomeTeam?: string;
  strAwayTeam?: string;
  strTimestamp?: string;
  dateEvent?: string;
  strTime?: string;
  strLeague?: string;
  idLeague?: string;
}

async function fetchSportsDbLeagueNext(league: { id: string; name: string }, daysAhead: number): Promise<OddsApiEvent[]> {
  try {
    const res = await fetch(`${SPORTSDB_BASE}/eventsnextleague.php?id=${league.id}`);
    if (!res.ok) return [];
    const json = (await res.json()) as { events?: SportsDbEvent[] };
    const events = json.events ?? [];
    const horizon = Date.now() + daysAhead * 86_400_000;
    const mapped: OddsApiEvent[] = [];
    for (const ev of events) {
      const iso = ev.strTimestamp
        ? (ev.strTimestamp.endsWith("Z") ? ev.strTimestamp : `${ev.strTimestamp}Z`)
        : ev.dateEvent && ev.strTime
          ? `${ev.dateEvent}T${ev.strTime}${ev.strTime.includes("+") || ev.strTime.endsWith("Z") ? "" : "Z"}`
          : null;
      if (!iso) continue;
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts) || ts < Date.now() - 2 * 3_600_000 || ts > horizon) continue;
      if (!ev.strHomeTeam || !ev.strAwayTeam) continue;
      mapped.push({
        id: `sportsdb-${league.id}-${ev.idEvent}`,
        sport_key: `soccer_sportsdb_${league.id}`,
        sport_title: ev.strLeague ?? league.name,
        commence_time: new Date(ts).toISOString(),
        home_team: ev.strHomeTeam,
        away_team: ev.strAwayTeam,
        bookmakers: [{
          key: FALLBACK_BOOKMAKER,
          title: "Fixture model",
          last_update: new Date().toISOString(),
          markets: [{
            key: "h2h",
            outcomes: [
              { name: ev.strHomeTeam, price: 1.91 },
              { name: "Draw", price: 3.35 },
              { name: ev.strAwayTeam, price: 3.95 },
            ],
          }],
        }],
      });
    }
    return mapped;
  } catch (error) {
    console.warn(`sportsdb league ${league.id}:`, (error as Error).message);
    return [];
  }
}

const SPORT_KEY_BY_ESPN = Object.fromEntries(
  Object.entries(ESPN_LEAGUES).flatMap(([sportKey, slugs]) => slugs.map((slug) => [slug, sportKey])),
) as Record<string, string>;

interface EspnEvent {
  id: string;
  date: string;
  name?: string;
  competitions?: Array<{
    odds?: EspnOdds[];
    status?: { type?: { name?: string; completed?: boolean } };
    competitors?: Array<{
      homeAway?: "home" | "away";
      team?: { displayName?: string; name?: string };
    }>;
  }>;
  league?: { name?: string };
}

interface EspnOdds {
  provider?: { name?: string; displayName?: string };
  drawOdds?: { moneyLine?: number };
  moneyline?: {
    home?: { close?: { odds?: string }; open?: { odds?: string } };
    away?: { close?: { odds?: string }; open?: { odds?: string } };
  };
  total?: {
    over?: { close?: { odds?: string; line?: string }; open?: { odds?: string; line?: string } };
    under?: { close?: { odds?: string; line?: string }; open?: { odds?: string; line?: string } };
  };
  overUnder?: number;
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
  // 1) ESPN — auto-discover the full soccer league catalogue.
  const espnSlugs = await discoverEspnSoccerSlugs();
  // Cap concurrent slug fetches to keep the burst polite.
  const espnBatches = await runWithConcurrency(espnSlugs, 8, (slug) =>
    fetchEspnSlug(slug, SPORT_KEY_BY_ESPN[slug] ?? `soccer_${slug.replace(/\W+/g, "_")}`, daysAhead),
  );
  const espnEvents = espnBatches.flat();

  // 2) TheSportsDB — fill gaps ESPN doesn't cover (regional / lower divisions).
  const sportsDbLeagues = await discoverSportsDbLeagues();
  const sportsDbBatches = await runWithConcurrency(sportsDbLeagues, 6, (league) =>
    fetchSportsDbLeagueNext(league, daysAhead),
  );
  const sportsDbEvents = sportsDbBatches.flat();

  return dedupeEvents([...espnEvents, ...sportsDbEvents]);
}

async function runWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try { results[idx] = await task(items[idx]); }
      catch { results[idx] = ([] as unknown) as R; }
    }
  });
  await Promise.all(workers);
  return results;
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

  const bookmaker = mapOdds(competition?.odds?.[0], homeName, awayName);
  return {
    id: `espn-${sportKey}-${event.id}`,
    sport_key: sportKey,
    sport_title: leagueName,
    commence_time: event.date,
    home_team: homeName,
    away_team: awayName,
    bookmakers: [bookmaker],
  };
}

function mapOdds(odds: EspnOdds | undefined, homeName: string, awayName: string) {
  const home = americanToDecimal(odds?.moneyline?.home?.close?.odds ?? odds?.moneyline?.home?.open?.odds);
  const away = americanToDecimal(odds?.moneyline?.away?.close?.odds ?? odds?.moneyline?.away?.open?.odds);
  const draw = americanToDecimal(odds?.drawOdds?.moneyLine);
  const markets: OddsApiBookmaker["markets"] = [{
    key: "h2h",
    outcomes: [
      { name: homeName, price: home ?? 1.91 },
      { name: "Draw", price: draw ?? 3.35 },
      { name: awayName, price: away ?? 3.95 },
    ],
  }];

  const point = odds?.overUnder ?? parseLine(odds?.total?.over?.close?.line ?? odds?.total?.under?.close?.line);
  const over = americanToDecimal(odds?.total?.over?.close?.odds ?? odds?.total?.over?.open?.odds);
  const under = americanToDecimal(odds?.total?.under?.close?.odds ?? odds?.total?.under?.open?.odds);
  if (point && over && under) {
    markets.push({
      key: "totals",
      outcomes: [
        { name: "Over", price: over, point },
        { name: "Under", price: under, point },
      ],
    });
  }

  const title = odds?.provider?.displayName ?? odds?.provider?.name ?? "Fixture model";
  return {
    key: odds ? slugify(title) : FALLBACK_BOOKMAKER,
    title,
    last_update: new Date().toISOString(),
    markets,
  };
}

function americanToDecimal(value: string | number | undefined) {
  if (value == null) return undefined;
  const moneyline = typeof value === "number" ? value : Number(value.replace(/[+\s]/g, ""));
  if (!Number.isFinite(moneyline) || moneyline === 0) return undefined;
  const decimal = moneyline > 0 ? 1 + moneyline / 100 : 1 + 100 / Math.abs(moneyline);
  return Number(decimal.toFixed(2));
}

function parseLine(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[ou]/i, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || FALLBACK_BOOKMAKER;
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