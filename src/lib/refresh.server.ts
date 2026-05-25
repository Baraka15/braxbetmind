/** Orchestrates: fetch odds + real results → fit models → ensemble → AI tier → store bets. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchOddsForLeague, isSharpBook, type OddsApiEvent } from "./odds-api.server";
import { fetchFinishedMatches } from "./football-data.server";
import { runEnsemble, type BookOdds } from "./ensemble.server";
import { reason } from "./ai-reasoning.server";
import { edgeForOutcome, isSharpMove, kellyStakePct } from "./value-engine.server";

const DEFAULT_LEAGUES = [
  "soccer_epl",
  "soccer_uefa_champs_league",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
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
    // Refresh historical results for this league (feeds Elo + Dixon-Coles)
    try { await fetchFinishedMatches(league); } catch (e) { summary.errors.push(`results ${league}: ${(e as Error).message}`); }

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

  // Run the ensemble
  const selections = await runEnsemble({ event: ev, books, openingPinn: pinnOpening, currentPinn: pinnCurrent });

  for (const sel of selections) {
    const { edgePct, impliedProb } = edgeForOutcome(sel.finalProb, sel.bestOdds);
    if (edgePct < MIN_EDGE) {
      await supabaseAdmin.from("bets").delete().eq("match_id", ev.id).eq("market", sel.market).eq("selection", sel.selection);
      continue;
    }

    // L7: AI reasoning (best-effort)
    let tier: "S" | "A" | "B" | "C" = edgePct >= 0.08 ? "S" : edgePct >= 0.05 ? "A" : edgePct >= 0.03 ? "B" : "C";
    let rationale = `${(edgePct * 100).toFixed(1)}% edge vs market consensus.`;
    let finalProb = sel.finalProb;
    try {
      const r = await reason({
        home: ev.home_team, away: ev.away_team, league: ev.sport_title,
        market: sel.market, selection: sel.selection,
        bestOdds: sel.bestOdds, bookmaker: sel.bookmaker,
        layers: sel.layers, finalProb: sel.finalProb, edgePct,
      });
      if (r) {
        tier = r.tier;
        rationale = r.rationale;
        finalProb = r.adjustedProb;
      }
    } catch { /* keep defaults */ }

    const finalEdge = finalProb - 1 / sel.bestOdds;
    if (finalEdge < MIN_EDGE) {
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
      model_scores: sel.layers,
      consensus_prob: sel.layers.marketConsensus,
    }, { onConflict: "match_id,market,selection" });
    summary.bets++;
    if (sharpAlert) summary.sharp++;
  }
}
