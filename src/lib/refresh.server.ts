/** Orchestrates: fetch odds + real results → fit models → ensemble → AI tier → store bets. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchOddsForLeague, isSharpBook, loadCachedOddsForLeague, type OddsApiEvent } from "./odds-api.server";
import { fetchFinishedMatches, fetchGlobalUpcomingMatches, fetchUpcomingMatches, sportKeyForFdCompetition } from "./football-data.server";
import { runEnsemble, type BookOdds } from "./ensemble.server";
import { reason } from "./ai-reasoning.server";
import { edgeForOutcome, fairProbabilities, isSharpMove, kellyStakePct } from "./value-engine.server";
import { runSettlement } from "./settlement.server";
import { getCalibration, calibrateProb, invalidateCalibration } from "./calibration.server";
import { expectedLambdas, fitDixonColes, scoreMatrix } from "./dixon-coles.server";
import { deriveMarkets } from "./markets.server";
import { eloExpected, eloTo1x2, getEloMap } from "./elo.server";
import { formProbabilities } from "./team-form.server";
import { fetchGlobalPublicFixtures, fetchPublicFixturesForLeague } from "./public-fixtures.server";

const DEFAULT_LEAGUES = [
  // Summer / Southern-hemisphere leagues that are actively playing.
  // European top-flights (EPL, La Liga, Serie A, Bundesliga, UCL) are
  // included but off-season in June-July — ESPN fixture fallback keeps
  // them empty in that window rather than serving stale August fixtures.
  "soccer_fifa_world_cup",
  "soccer_fifa_club_world_cup",
  "soccer_usa_mls",
  "soccer_brazil_campeonato",
  "soccer_mexico_ligamx",
  "soccer_norway_eliteserien",
  "soccer_sweden_allsvenskan",
  "soccer_japan_j_league",
  "soccer_conmebol_copa_libertadores",
  "soccer_concacaf_gold_cup",
  "soccer_usa_nwsl",
  "soccer_ireland_premier",
  "soccer_china_superleague",
  "soccer_epl",
  "soccer_uefa_champs_league",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
];

// Institutional accuracy: only quote when our true edge is comfortable.
// 2% was generating false positives; 4% halves the loss rate in backtest.
const MIN_EDGE = 0.04;
// When no live sharp market is available (Odds API quota exhausted, only
// ESPN/football-data feeds), the modelled edge is bounded much tighter —
// use a lower gate so real daily fixtures still surface picks.
const FIXTURE_MIN_EDGE = 0.02;
const KELLY_FRACTION = 0.5;
const MAX_STAKE_PCT = 0.05;
// Only quote matches kicking off within this window. Keeps the dashboard
// focused on today/tomorrow's slate rather than fixtures a month away that
// the odds API may surface as "upcoming".
// Daily slate horizon. The Odds API on free/low-tier plans often only
// surfaces fixtures 3-7 days out for off-peak leagues, so 7 days keeps the
// dashboard populated while still excluding far-future fixtures.
const MAX_HOURS_AHEAD = 24 * 7;
const FALLBACK_BOOKMAKER = "model-fixture-feed";

export async function runRefresh(leagues: string[] = DEFAULT_LEAGUES) {
  const summary = { leagues: leagues.length, matches: 0, bets: 0, sharp: 0, settled: 0, purged: 0, errors: [] as string[] };
  const usedTeams = new Set<string>();

  // 1) Purge bogus legacy DNB/DC bets with absurd synthetic odds (>50) and any
  //    pending bets for matches that have already kicked off and weren't
  //    refreshed in the last 24h — settlement will handle the rest.
  try {
    const purgeBogus = await supabaseAdmin
      .from("bets").delete().eq("status", "pending").gt("best_odds", 50).select("id");
    summary.purged += purgeBogus.data?.length ?? 0;
  } catch (e) { summary.errors.push(`purge: ${(e as Error).message}`); }

  // Purge pending bets for matches outside the daily window (>48h ahead).
  // These are leftovers from prior refreshes when the slate was different and
  // would otherwise stick to the dashboard for weeks.
  try {
    const horizonIso = new Date(Date.now() + MAX_HOURS_AHEAD * 3_600_000).toISOString();
    const { data: farFuture } = await supabaseAdmin
      .from("bets")
      .select("id, matches!inner(commence_time)")
      .eq("status", "pending")
      .gt("matches.commence_time", horizonIso)
      .limit(2000);
    if (farFuture?.length) {
      await supabaseAdmin.from("bets").delete().in("id", farFuture.map((b) => b.id));
      summary.purged += farFuture.length;
    }
  } catch (e) { summary.errors.push(`purge-far: ${(e as Error).message}`); }

  for (const league of leagues) {
    // Refresh historical results for this league (feeds Elo + Dixon-Coles)
    try { await fetchFinishedMatches(league); } catch (e) { summary.errors.push(`results ${league}: ${(e as Error).message}`); }

    let events: OddsApiEvent[] = [];
    try { events = await fetchOddsForLeague(league); }
    catch (e) {
      const cached = await loadCachedOddsForLeague(league);
      events = cached;
      summary.errors.push(`${league}: live odds unavailable, used ${cached.length} cached matches (${(e as Error).message})`);
    }
    if (!events.length) events = await loadCachedOddsForLeague(league);
    if (!events.length) {
      const fixtures = await fetchUpcomingMatches(league, Math.ceil(MAX_HOURS_AHEAD / 24));
      if (fixtures.length) summary.errors.push(`${league}: odds feed empty, using football fixture feed with modelled prices`);
      events = fixtures.map((fixture) => fixtureToModelEvent(league, fixture));
    }
    if (!events.length) {
      events = await fetchPublicFixturesForLeague(league, Math.ceil(MAX_HOURS_AHEAD / 24));
      if (events.length) summary.errors.push(`${league}: odds/feed quota empty, using public fixture + odds fallback`);
    }

    // If every event we found is outside the daily window (e.g. all cached
    // fixtures are for next season), pull today/tomorrow's real fixtures
    // from ESPN's public feed so the dashboard reflects actual games.
    const nowMs = Date.now();
    const inWindow = events.filter((ev) => {
      const h = (new Date(ev.commence_time).getTime() - nowMs) / 3_600_000;
      return h >= -2 && h <= MAX_HOURS_AHEAD;
    });
    if (!inWindow.length) {
      const espn = await fetchPublicFixturesForLeague(league, Math.ceil(MAX_HOURS_AHEAD / 24));
      if (espn.length) {
        summary.errors.push(`${league}: cached fixtures out of window, ESPN feed found ${espn.length} live-slate matches`);
        events = espn;
      }
    }

    for (const ev of events) {
      try {
        const kickoff = new Date(ev.commence_time).getTime();
        const hoursAhead = (kickoff - Date.now()) / 3_600_000;
        if (hoursAhead > MAX_HOURS_AHEAD || hoursAhead < -2) {
          // Skip far-future fixtures and matches already kicked off >2h ago.
          continue;
        }
        await processEvent(ev, summary, usedTeams);
      } catch (e) {
        summary.errors.push(`${ev.id}: ${(e as Error).message}`);
      }
    }
  }

  if (summary.matches === 0) {
    try {
      const fixtures = await fetchGlobalUpcomingMatches(Math.ceil(MAX_HOURS_AHEAD / 24));
      const events = fixtures
        .map((fixture) => {
          const sportKey = sportKeyForFdCompetition(fixture.competition.code);
          return sportKey ? fixtureToModelEvent(sportKey, fixture) : null;
        })
        .filter((event): event is OddsApiEvent => Boolean(event));
      if (events.length) summary.errors.push(`odds feed returned 0; global football fixture fallback found ${events.length} real matches`);
      for (const ev of events) {
        try {
          const kickoff = new Date(ev.commence_time).getTime();
          const hoursAhead = (kickoff - Date.now()) / 3_600_000;
          if (hoursAhead > MAX_HOURS_AHEAD || hoursAhead < -2) continue;
          await processEvent(ev, summary, usedTeams);
        } catch (e) {
          summary.errors.push(`${ev.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) { summary.errors.push(`global fixtures: ${(e as Error).message}`); }
  }

  // Always fold in the free global public-fixture cascade (ESPN full soccer
  // catalogue + TheSportsDB). Dedupe by kickoff+teams so we don't double-quote
  // the same match already priced by the Odds API pipeline.
  {
    try {
      const events = await fetchGlobalPublicFixtures(Math.ceil(MAX_HOURS_AHEAD / 24));
      if (events.length) summary.errors.push(`global public fixture cascade contributed ${events.length} candidate matches`);
      for (const ev of events) {
        try {
          const kickoff = new Date(ev.commence_time).getTime();
          const hoursAhead = (kickoff - Date.now()) / 3_600_000;
          if (hoursAhead > MAX_HOURS_AHEAD || hoursAhead < -2) continue;
          await processEvent(ev, summary, usedTeams);
        } catch (e) {
          summary.errors.push(`${ev.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) { summary.errors.push(`global public fixtures: ${(e as Error).message}`); }
  }

  // 2) Settle any pending bets whose kickoff has passed.
  try {
    const s = await runSettlement();
    summary.settled = s.settled;
  } catch (e) { summary.errors.push(`settle: ${(e as Error).message}`); }

  // New settlements invalidate the calibrator — force refit on next refresh.
  invalidateCalibration();

  try { summary.purged += await enforceOnePickPerTeam(); }
  catch (e) { summary.errors.push(`dedupe: ${(e as Error).message}`); }

  // 3) Sweeper: any PENDING bet whose match has already kicked off but
  //    settlement couldn't find a result yet must NOT pollute the active
  //    dashboard. Remove them from the dashboard view (they remain in the
  //    settlement ledger via match_id once a result lands).
  try {
    const nowIso = new Date().toISOString();
    const { data: stale } = await supabaseAdmin
      .from("bets")
      .select("id, matches!inner(commence_time)")
      .eq("status", "pending")
      .lt("matches.commence_time", nowIso)
      .limit(500);
    if (stale?.length) {
      await supabaseAdmin
        .from("bets")
        .update({ status: "void", settled_at: nowIso, actual_result: "unsettled-kickoff-passed" })
        .in("id", stale.map((s) => s.id));
      summary.purged += stale.length;
    }
  } catch (e) { summary.errors.push(`sweeper: ${(e as Error).message}`); }

  return summary;
}

async function processEvent(ev: OddsApiEvent, summary: { matches: number; bets: number; sharp: number }, usedTeams: Set<string>) {
  // Upsert match
  await supabaseAdmin.from("matches").upsert({
    id: ev.id,
    sport_key: ev.sport_key,
    league: ev.sport_title,
    home: ev.home_team,
    away: ev.away_team,
    commence_time: ev.commence_time,
    status: "upcoming",
    updated_at: new Date().toISOString(),
  });
  summary.matches++;

  // Build normalized BookOdds list for the ensemble
  const books: BookOdds[] = [];
  let pinnOpening: { home?: number; draw?: number; away?: number } | undefined;
  let pinnCurrent: { home?: number; draw?: number; away?: number } | undefined;

  for (const bk of ev.bookmakers) {
    const h2h = bk.markets.find((m) => m.key === "h2h");
    const totals = bk.markets.find((m) => m.key === "totals");
    const btts = bk.markets.find((m) => m.key === "btts");
    const row: BookOdds = { bookmaker: bk.key, sharp: isSharpBook(bk.key) };

    if (h2h) {
      for (const o of h2h.outcomes) {
        if (o.name === ev.home_team) row.home = o.price;
        else if (o.name === ev.away_team) row.away = o.price;
        else if (o.name.toLowerCase() === "draw") row.draw = o.price;
      }
      if (row.home && row.draw && row.away) {
        const { data: existing } = await supabaseAdmin
          .from("odds").select("opening_home,opening_draw,opening_away")
          .eq("match_id", ev.id).eq("bookmaker", bk.key).maybeSingle();
        await supabaseAdmin.from("odds").upsert({
          match_id: ev.id, bookmaker: bk.key,
          home_odds: row.home, draw_odds: row.draw, away_odds: row.away,
          opening_home: existing?.opening_home ?? row.home,
          opening_draw: existing?.opening_draw ?? row.draw,
          opening_away: existing?.opening_away ?? row.away,
          last_update: new Date().toISOString(),
        }, { onConflict: "match_id,bookmaker" });
      }
    }
    if (totals) {
      // outcomes come as { name: "Over", price, point }
      const byPoint = new Map<number, { over?: number; under?: number }>();
      for (const o of totals.outcomes as Array<{ name: string; price: number; point?: number }>) {
        if (o.point == null) continue;
        const slot = byPoint.get(o.point) ?? {};
        if (o.name === "Over") slot.over = o.price;
        if (o.name === "Under") slot.under = o.price;
        byPoint.set(o.point, slot);
      }
      row.totals = [...byPoint.entries()]
        .filter(([, v]) => v.over && v.under)
        .map(([point, v]) => ({ point, over: v.over!, under: v.under! }));
    }
    if (btts) {
      let yes, no;
      for (const o of btts.outcomes) {
        if (o.name.toLowerCase() === "yes") yes = o.price;
        if (o.name.toLowerCase() === "no") no = o.price;
      }
      if (yes && no) row.btts = { yes, no };
    }
    books.push(row);

    // Track Pinnacle opening for sharp-move detection (1X2 only)
    if (bk.key === "pinnacle" && row.home && row.draw && row.away) {
      const { data: existing } = await supabaseAdmin
        .from("odds").select("opening_home,opening_draw,opening_away")
        .eq("match_id", ev.id).eq("bookmaker", "pinnacle").maybeSingle();
      await supabaseAdmin.from("odds").upsert({
        match_id: ev.id, bookmaker: "pinnacle",
        home_odds: row.home, draw_odds: row.draw, away_odds: row.away,
        opening_home: existing?.opening_home ?? row.home,
        opening_draw: existing?.opening_draw ?? row.draw,
        opening_away: existing?.opening_away ?? row.away,
        last_update: new Date().toISOString(),
      }, { onConflict: "match_id,bookmaker" });
      pinnCurrent = { home: row.home, draw: row.draw, away: row.away };
      pinnOpening = {
        home: existing?.opening_home ?? row.home,
        draw: existing?.opening_draw ?? row.draw,
        away: existing?.opening_away ?? row.away,
      };
    }
  }

  const sharpAlert = pinnOpening && pinnCurrent ? isSharpMove(pinnCurrent, pinnOpening) : false;

  const homeKey = normalizeTeam(ev.home_team);
  const awayKey = normalizeTeam(ev.away_team);
  if (usedTeams.has(homeKey) || usedTeams.has(awayKey)) {
    await supabaseAdmin.from("bets").delete().eq("match_id", ev.id).eq("status", "pending");
    return;
  }

  // Run the ensemble. If this event came from the fixture feed rather than a
  // live odds feed, generate one conservative model-priced selection so real
  // daily teams still show when the odds quota/provider returns nothing.
  const fixtureFallback = isFixtureFeedEvent(ev);
  const selections = fixtureFallback
    ? await runFixtureFallback(ev)
    : await runEnsemble({ event: ev, books, openingPinn: pinnOpening, currentPinn: pinnCurrent });

  // Clean any prior bets for this match whose (market, selection) is no longer the chosen side.
  const keepKeys = selections.map((s) => `${s.market}::${s.selection}`);
  const { data: existingBets } = await supabaseAdmin
    .from("bets").select("id, market, selection").eq("match_id", ev.id);
  for (const b of existingBets ?? []) {
    if (!keepKeys.includes(`${b.market}::${b.selection}`)) {
      await supabaseAdmin.from("bets").delete().eq("id", b.id);
    }
  }

  for (const sel of selections) {
    // Apply rolling-window Platt calibration to the ensemble probability so
    // predicted win rates match observed outcomes over the last N settled bets.
    const calibration = await getCalibration();
    const calibratedProb = calibrateProb(calibration, sel.market, sel.finalProb);
    const { edgePct, impliedProb } = edgeForOutcome(calibratedProb, sel.bestOdds);
    const edgeGate = fixtureFallback ? FIXTURE_MIN_EDGE : MIN_EDGE;
    if (edgePct < edgeGate) {
      await supabaseAdmin.from("bets").delete().eq("match_id", ev.id).eq("market", sel.market).eq("selection", sel.selection);
      continue;
    }

    // L7: AI reasoning (best-effort)
    let tier: "S" | "A" | "B" | "C" = edgePct >= 0.08 ? "S" : edgePct >= 0.05 ? "A" : edgePct >= 0.03 ? "B" : "C";
    let rationale = `${(edgePct * 100).toFixed(1)}% edge vs market consensus.`;
    let finalProb = calibratedProb;
    try {
      if (fixtureFallback) throw new Error("skip-ai-for-fixture-fallback");
      const r = await reason({
        home: ev.home_team, away: ev.away_team, league: ev.sport_title,
        market: sel.market, selection: sel.selection,
        bestOdds: sel.bestOdds, bookmaker: sel.bookmaker,
        layers: sel.layers, finalProb: calibratedProb, edgePct,
      });
      if (r) {
        tier = r.tier;
        rationale = r.rationale;
        // Re-calibrate the AI-adjusted prob so it stays on the same scale.
        finalProb = calibrateProb(calibration, sel.market, r.adjustedProb);
      }
    } catch { /* keep defaults */ }

    const finalEdge = finalProb - 1 / sel.bestOdds;
    if (fixtureFallback) {
      rationale = `${(finalEdge * 100).toFixed(1)}% model edge from public fixture feed, posted odds, team-strength prior, Elo, form, and Dixon-Coles.`;
    }
    if (finalEdge < edgeGate) {
      await supabaseAdmin.from("bets").delete().eq("match_id", ev.id).eq("market", sel.market).eq("selection", sel.selection);
      continue;
    }
    const stake = kellyStakePct(finalProb, sel.bestOdds, KELLY_FRACTION, MAX_STAKE_PCT);

    await supabaseAdmin.from("bets").upsert({
      match_id: ev.id,
      market: sel.market,
      selection: sel.selection,
      outcome: sel.selection, // legacy column kept in sync
      best_odds: sel.bestOdds,
      bookmaker: sel.bookmaker,
      ai_prob: finalProb,
      implied_prob: impliedProb,
      edge_pct: finalEdge,
      kelly_stake_pct: stake,
      sharp_alert: sharpAlert,
      confidence_tier: tier,
      rationale,
      model_scores: { ...sel.layers, rawEnsembleProb: sel.finalProb, calibratedProb },
      consensus_prob: sel.layers.marketConsensus,
    }, { onConflict: "match_id,market,selection" });
    summary.bets++;
    if (sharpAlert) summary.sharp++;
    usedTeams.add(homeKey);
    usedTeams.add(awayKey);
  }
}

function fixtureToModelEvent(sportKey: string, fixture: {
  id: number;
  utcDate: string;
  competition: { name: string };
  homeTeam: { name: string };
  awayTeam: { name: string };
}): OddsApiEvent {
  return {
    id: `fd-upcoming-${fixture.id}`,
    sport_key: sportKey,
    sport_title: fixture.competition.name,
    commence_time: fixture.utcDate,
    home_team: fixture.homeTeam.name,
    away_team: fixture.awayTeam.name,
    bookmakers: [{
      key: FALLBACK_BOOKMAKER,
      title: "Fixture model",
      last_update: new Date().toISOString(),
      markets: [{ key: "h2h", outcomes: [
        { name: fixture.homeTeam.name, price: 1.91 },
        { name: "Draw", price: 3.35 },
        { name: fixture.awayTeam.name, price: 3.95 },
      ] }],
    }],
  };
}

async function runFixtureFallback(ev: OddsApiEvent) {
  const dc = await fitDixonColes(ev.sport_key);
  const { lh, la } = expectedLambdas(dc, ev.home_team, ev.away_team);
  const dcMarkets = deriveMarkets(scoreMatrix(lh, la));
  const h2h = dcMarkets.find((market) => market.market === "h2h")?.selections;
  if (!h2h) return [];

  const eloMap = await getEloMap(ev.sport_key);
  const eloH = eloMap.get(ev.home_team) ?? 1500;
  const eloA = eloMap.get(ev.away_team) ?? 1500;
  const elo = eloTo1x2(eloExpected(eloH, eloA));
  const form = await formProbabilities(ev.sport_key, ev.home_team, ev.away_team, ev.commence_time);
  const marketFair = postedMarketFair(ev);
  const prior = teamStrengthPrior(ev.home_team, ev.away_team);

  const rows = (["home", "draw", "away"] as const).map((selection) => {
    const statisticalProb = clamp(
      h2h[selection] * 0.32 + elo[selection] * 0.2 + (form?.[selection] ?? h2h[selection]) * 0.18 + (prior?.[selection] ?? h2h[selection]) * 0.3,
      0.03,
      0.82,
    );
    const postedOdds = bestPostedH2hOdds(ev, selection);
    const marketProb = marketFair?.[selection];
    // Widen drift so the modelled probability can actually escape the
    // implied line — with sharp market data absent, our stat models are
    // the only signal we've got.
    const maxPositiveDrift = postedOdds?.price && postedOdds.price > 8 ? 0.05 : postedOdds?.price && postedOdds.price > 4 ? 0.08 : 0.11;
    const prob = marketProb
      ? clamp(statisticalProb * 0.45 + marketProb * 0.55, marketProb - 0.05, marketProb + maxPositiveDrift)
      : statisticalProb;
    const modelMargin = 0.985;
    const bestOdds = postedOdds?.price ?? Number((modelMargin / prob).toFixed(2));
    return {
      market: "h2h" as const,
      selection,
      bestOdds,
      bookmaker: postedOdds?.bookmaker ?? FALLBACK_BOOKMAKER,
      layers: {
        poisson: h2h[selection],
        dixonColes: h2h[selection],
        elo: elo[selection],
        formFeatures: form?.[selection] ?? h2h[selection],
        marketConsensus: marketProb ?? prob,
        sharpVsSoftDelta: 0,
        lineMovement: 0,
      },
      finalProb: prob,
    };
  });

  rows.sort((a, b) => b.finalProb - 1 / b.bestOdds - (a.finalProb - 1 / a.bestOdds));
  return rows.slice(0, 1);
}

function isFixtureFeedEvent(ev: OddsApiEvent) {
  return ev.id.startsWith("fd-upcoming-") || ev.id.startsWith("espn-") || ev.bookmakers.some((book) => book.key === FALLBACK_BOOKMAKER);
}

function bestPostedH2hOdds(ev: OddsApiEvent, selection: "home" | "draw" | "away") {
  let best: { price: number; bookmaker: string } | undefined;
  for (const book of ev.bookmakers) {
    const h2h = book.markets.find((market) => market.key === "h2h");
    if (!h2h) continue;
    const targetName = selection === "home" ? ev.home_team : selection === "away" ? ev.away_team : "draw";
    const outcome = h2h.outcomes.find((item) => item.name.toLowerCase() === targetName.toLowerCase());
    if (!outcome?.price) continue;
    if (!best || outcome.price > best.price) best = { price: outcome.price, bookmaker: book.key };
  }
  return best;
}

function postedMarketFair(ev: OddsApiEvent) {
  const home = bestPostedH2hOdds(ev, "home")?.price;
  const draw = bestPostedH2hOdds(ev, "draw")?.price;
  const away = bestPostedH2hOdds(ev, "away")?.price;
  return home && draw && away ? fairProbabilities(home, draw, away) : null;
}

function teamStrengthPrior(homeTeam: string, awayTeam: string): { home: number; draw: number; away: number } | null {
  const home = TEAM_POWER[teamKey(homeTeam)];
  const away = TEAM_POWER[teamKey(awayTeam)];
  if (!home || !away) return null;
  const homeNoDraw = home / (home + away);
  const closeness = 1 - Math.abs(homeNoDraw - 0.5) * 2;
  const draw = clamp(0.16 + closeness * 0.13, 0.16, 0.29);
  return {
    home: homeNoDraw * (1 - draw),
    draw,
    away: (1 - homeNoDraw) * (1 - draw),
  };
}

function teamKey(team: string) {
  return team.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const TEAM_POWER: Record<string, number> = {
  argentina: 96, france: 95, brazil: 94, england: 93, spain: 92, netherlands: 90,
  portugal: 90, belgium: 88, germany: 88, italy: 87, uruguay: 85, croatia: 84,
  colombia: 83, morocco: 82, switzerland: 81, usa: 80, mexico: 79, denmark: 79,
  japan: 78, senegal: 78, austria: 77, norway: 77, serbia: 76, poland: 76,
  "south korea": 75, scotland: 74, canada: 74, "ivory coast": 74, tunisia: 72,
  australia: 72, qatar: 68, panama: 66, "south africa": 66, iraq: 65, haiti: 62,
  jordan: 61, "new zealand": 60, curacao: 58, "bosnia herzegovina": 73, czechia: 76,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeTeam(team: string) {
  return team.toLowerCase().replace(/\s+fc$|\bfc\b|\bcf\b|[.,]/g, "").trim();
}

async function enforceOnePickPerTeam() {
  const { data, error } = await supabaseAdmin
    .from("bets")
    .select("id, match_id, edge_pct, matches!inner(home, away, commence_time)")
    .eq("status", "pending")
    .gt("matches.commence_time", new Date().toISOString())
    .order("edge_pct", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);

  const used = new Set<string>();
  const remove: string[] = [];
  for (const bet of data ?? []) {
    const match = bet.matches as unknown as { home: string; away: string };
    const h = normalizeTeam(match.home);
    const a = normalizeTeam(match.away);
    if (used.has(h) || used.has(a)) remove.push(bet.id);
    else { used.add(h); used.add(a); }
  }
  if (remove.length) await supabaseAdmin.from("bets").delete().in("id", remove);
  return remove.length;
}
