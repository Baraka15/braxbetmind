import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isSharpBook } from "./odds-api.server";

export interface BookMove {
  bookmaker: string;
  isSharp: boolean;
  home: { opening: number | null; current: number | null; driftPct: number | null };
  draw: { opening: number | null; current: number | null; driftPct: number | null };
  away: { opening: number | null; current: number | null; driftPct: number | null };
  lastUpdate: string;
}

export interface SharpMove {
  matchId: string;
  home: string;
  away: string;
  league: string | null;
  commenceTime: string;
  // Net implied-probability shift (current - opening) on sharp books only.
  // Positive on a side = market has SHORTENED that side (money came in).
  sharpShift: { home: number; draw: number; away: number };
  // Magnitude across all books — sum of absolute % drift per outcome.
  magnitude: number;
  // Steam direction: which outcome moved most on sharps.
  steam: "home" | "draw" | "away" | null;
  books: BookMove[];
}

function pct(curr: number | null, opening: number | null): number | null {
  if (!curr || !opening || opening <= 1.01) return null;
  return (curr - opening) / opening;
}

function impliedShift(curr: number | null, opening: number | null): number {
  if (!curr || !opening) return 0;
  return 1 / curr - 1 / opening;
}

/**
 * Sharp-moves board. Aggregates per-bookmaker odds drift (opening → current)
 * for upcoming matches the user is tracking, and surfaces "steam" moves where
 * sharp books (Pinnacle, Betfair, Circa) have collectively shortened a price.
 *
 * Note: bookmaker volume is not exposed by the public Odds API, so the
 * volume-spike column shows the implied-probability shift on sharps as a
 * proxy — that is the public, model-able signal.
 */
export const getSharpMoves = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const nowIso = new Date().toISOString();

    const { data: matches, error: mErr } = await supabase
      .from("matches")
      .select("id, home, away, league, commence_time")
      .gt("commence_time", nowIso)
      .order("commence_time", { ascending: true })
      .limit(40);
    if (mErr) throw new Error(mErr.message);
    if (!matches?.length) return { moves: [] as SharpMove[], generatedAt: nowIso };

    const ids = matches.map((m) => m.id);
    const { data: oddsRows, error: oErr } = await supabase
      .from("odds")
      .select("match_id, bookmaker, home_odds, draw_odds, away_odds, opening_home, opening_draw, opening_away, last_update")
      .in("match_id", ids);
    if (oErr) throw new Error(oErr.message);

    const byMatch = new Map<string, typeof oddsRows>();
    for (const r of oddsRows ?? []) {
      const arr = byMatch.get(r.match_id) ?? [];
      arr.push(r);
      byMatch.set(r.match_id, arr);
    }

    const moves: SharpMove[] = [];
    for (const m of matches) {
      const rows = byMatch.get(m.id) ?? [];
      if (!rows.length) continue;

      const books: BookMove[] = rows.map((r) => ({
        bookmaker: r.bookmaker,
        isSharp: isSharpBook(r.bookmaker),
        home: { opening: r.opening_home, current: r.home_odds, driftPct: pct(r.home_odds, r.opening_home) },
        draw: { opening: r.opening_draw, current: r.draw_odds, driftPct: pct(r.draw_odds, r.opening_draw) },
        away: { opening: r.opening_away, current: r.away_odds, driftPct: pct(r.away_odds, r.opening_away) },
        lastUpdate: r.last_update,
      }));

      const sharps = books.filter((b) => b.isSharp);
      const useForShift = sharps.length ? sharps : books;
      const shift = { home: 0, draw: 0, away: 0 };
      let n = 0;
      for (const b of useForShift) {
        const r = rows.find((rr) => rr.bookmaker === b.bookmaker)!;
        shift.home += impliedShift(r.home_odds, r.opening_home);
        shift.draw += impliedShift(r.draw_odds, r.opening_draw);
        shift.away += impliedShift(r.away_odds, r.opening_away);
        n++;
      }
      if (n > 0) {
        shift.home /= n; shift.draw /= n; shift.away /= n;
      }

      const magnitude =
        books.reduce((s, b) => s + Math.abs(b.home.driftPct ?? 0) + Math.abs(b.draw.driftPct ?? 0) + Math.abs(b.away.driftPct ?? 0), 0);

      let steam: "home" | "draw" | "away" | null = null;
      const STEAM_THRESHOLD = 0.015; // ~1.5pp implied prob move on sharps
      const entries: Array<["home" | "draw" | "away", number]> = [
        ["home", shift.home],
        ["draw", shift.draw],
        ["away", shift.away],
      ];
      entries.sort((a, b) => b[1] - a[1]);
      if (entries[0][1] >= STEAM_THRESHOLD) steam = entries[0][0];

      moves.push({
        matchId: m.id,
        home: m.home,
        away: m.away,
        league: m.league,
        commenceTime: m.commence_time,
        sharpShift: shift,
        magnitude,
        steam,
        books,
      });
    }

    moves.sort((a, b) => b.magnitude - a.magnitude);
    return { moves, generatedAt: nowIso };
  });