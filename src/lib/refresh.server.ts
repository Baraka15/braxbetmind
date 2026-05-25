/** Orchestrates: fetch odds → upsert matches/odds → predict → compute bets. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchOddsForLeague, pickSharpOdds, SHARP_BOOKMAKERS, type OddsApiEvent } from "./odds-api.server";
import { predictMatch } from "./prediction.server";
import { edgeForOutcome, isSharpMove, kellyStakePct } from "./value-engine.server";

const DEFAULT_LEAGUES = [
  "soccer_epl",
  "soccer_uefa_champs_league",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  // In-season worldwide leagues so the scanner always finds matches.
  "soccer_usa_mls",
  "soccer_brazil_campeonato",
  "soccer_mexico_ligamx",
  "soccer_norway_eliteserien",
  "soccer_sweden_allsvenskan",
  "soccer_japan_j_league",
  "soccer_conmebol_copa_libertadores",
];

const MIN_EDGE = 0.02;
const KELLY_FRACTION = 0.5;
const MAX_STAKE_PCT = 0.05;

export async function runRefresh(leagues: string[] = DEFAULT_LEAGUES) {
  const summary = { leagues: leagues.length, matches: 0, bets: 0, sharp: 0, errors: [] as string[] };

  for (const league of leagues) {
    let events: OddsApiEvent[] = [];
    try {
      events = await fetchOddsForLeague(league);
    } catch (e) {
      summary.errors.push(`${league}: ${(e as Error).message}`);
      continue;
    }

    for (const ev of events) {
      try {
        await processEvent(ev, summary);
      } catch (e) {
        summary.errors.push(`${ev.id}: ${(e as Error).message}`);
      }
    }
  }

  return summary;
}

async function processEvent(ev: OddsApiEvent, summary: { matches: number; bets: number; sharp: number }) {
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

  // Upsert per-sharp-book odds (so we have opening prices)
  for (const bk of ev.bookmakers) {
    if (!SHARP_BOOKMAKERS.includes(bk.key as never)) continue;
    const market = bk.markets.find((m) => m.key === "h2h");
    if (!market) continue;
    let h, d, a;
    for (const o of market.outcomes) {
      if (o.name === ev.home_team) h = o.price;
      else if (o.name === ev.away_team) a = o.price;
      else if (o.name.toLowerCase() === "draw") d = o.price;
    }
    // Only set opening_* if row doesn't exist yet
    const { data: existing } = await supabaseAdmin
      .from("odds").select("opening_home").eq("match_id", ev.id).eq("bookmaker", bk.key).maybeSingle();

    await supabaseAdmin.from("odds").upsert({
      match_id: ev.id,
      bookmaker: bk.key,
      home_odds: h, draw_odds: d, away_odds: a,
      opening_home: existing?.opening_home ?? h,
      opening_draw: existing?.opening_home ? undefined : d,
      opening_away: existing?.opening_home ? undefined : a,
      last_update: new Date().toISOString(),
    }, { onConflict: "match_id,bookmaker" });
  }

  // Best odds for edge calc
  const best = pickSharpOdds(ev);
  if (!best.home || !best.draw || !best.away) return;

  // Predictions
  const probs = await predictMatch({
    matchId: ev.id, home: ev.home_team, away: ev.away_team, sportKey: ev.sport_key,
    marketOdds: { home: best.home.price, draw: best.draw.price, away: best.away.price },
  });
  await supabaseAdmin.from("predictions").upsert({
    match_id: ev.id,
    p_home: probs.p_home, p_draw: probs.p_draw, p_away: probs.p_away,
    source: probs.source, updated_at: new Date().toISOString(),
  });

  // Sharp-move check using Pinnacle opening vs current
  const { data: pinn } = await supabaseAdmin
    .from("odds").select("home_odds,draw_odds,away_odds,opening_home,opening_draw,opening_away")
    .eq("match_id", ev.id).eq("bookmaker", "pinnacle").maybeSingle();
  const sharpAlert = pinn
    ? isSharpMove(
        { home: pinn.home_odds ?? undefined, draw: pinn.draw_odds ?? undefined, away: pinn.away_odds ?? undefined },
        { home: pinn.opening_home ?? undefined, draw: pinn.opening_draw ?? undefined, away: pinn.opening_away ?? undefined },
      )
    : false;

  // Compute bets for each outcome
  const outcomes = [
    { key: "home" as const, prob: probs.p_home, odds: best.home.price, book: best.home.book },
    { key: "draw" as const, prob: probs.p_draw, odds: best.draw.price, book: best.draw.book },
    { key: "away" as const, prob: probs.p_away, odds: best.away.price, book: best.away.book },
  ];

  for (const o of outcomes) {
    const { edgePct, impliedProb } = edgeForOutcome(o.prob, o.odds);
    if (edgePct < MIN_EDGE) {
      // Remove any stale bet
      await supabaseAdmin.from("bets").delete().eq("match_id", ev.id).eq("outcome", o.key);
      continue;
    }
    const stake = kellyStakePct(o.prob, o.odds, KELLY_FRACTION, MAX_STAKE_PCT);
    await supabaseAdmin.from("bets").upsert({
      match_id: ev.id, outcome: o.key,
      best_odds: o.odds, bookmaker: o.book,
      ai_prob: o.prob, implied_prob: impliedProb,
      edge_pct: edgePct, kelly_stake_pct: stake,
      sharp_alert: sharpAlert,
    }, { onConflict: "match_id,outcome" });
    summary.bets++;
    if (sharpAlert) summary.sharp++;
  }
}
