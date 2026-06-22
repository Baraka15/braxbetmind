import { createFileRoute } from "@tanstack/react-router";
import { authenticateApiRequest, corsPreflight, jsonResponse } from "@/lib/api-auth.server";
import { isSharpBook } from "@/lib/odds-api.server";

export const Route = createFileRoute("/api/public/v1/sharp-moves")({
  server: {
    handlers: {
      OPTIONS: async () => corsPreflight(),
      GET: async ({ request }) => {
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;

        const url = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 1), 100);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const nowIso = new Date().toISOString();
        const { data: matches, error: mErr } = await supabaseAdmin
          .from("matches")
          .select("id, home, away, league, commence_time")
          .gt("commence_time", nowIso)
          .order("commence_time", { ascending: true })
          .limit(limit);
        if (mErr) return jsonResponse({ error: mErr.message }, 500);
        if (!matches?.length) return jsonResponse({ generated_at: nowIso, moves: [] });

        const ids = matches.map((m) => m.id);
        const { data: oddsRows, error: oErr } = await supabaseAdmin
          .from("odds")
          .select("match_id, bookmaker, home_odds, draw_odds, away_odds, opening_home, opening_draw, opening_away, last_update")
          .in("match_id", ids);
        if (oErr) return jsonResponse({ error: oErr.message }, 500);

        const shift = (curr: number | null, opening: number | null) =>
          curr && opening ? 1 / curr - 1 / opening : 0;
        const driftPct = (curr: number | null, opening: number | null) =>
          curr && opening && opening > 1.01 ? (curr - opening) / opening : null;

        const byMatch = new Map<string, typeof oddsRows>();
        for (const r of oddsRows ?? []) {
          const arr = byMatch.get(r.match_id) ?? [];
          arr.push(r);
          byMatch.set(r.match_id, arr);
        }

        const moves = matches.map((m) => {
          const rows = byMatch.get(m.id) ?? [];
          const sharps = rows.filter((r) => isSharpBook(r.bookmaker));
          const use = sharps.length ? sharps : rows;
          const agg = { home: 0, draw: 0, away: 0 };
          for (const r of use) {
            agg.home += shift(r.home_odds, r.opening_home);
            agg.draw += shift(r.draw_odds, r.opening_draw);
            agg.away += shift(r.away_odds, r.opening_away);
          }
          if (use.length) { agg.home /= use.length; agg.draw /= use.length; agg.away /= use.length; }
          const magnitude = rows.reduce(
            (s, r) => s + Math.abs(driftPct(r.home_odds, r.opening_home) ?? 0)
                      + Math.abs(driftPct(r.draw_odds, r.opening_draw) ?? 0)
                      + Math.abs(driftPct(r.away_odds, r.opening_away) ?? 0),
            0,
          );
          return {
            match_id: m.id, home: m.home, away: m.away, league: m.league,
            commence_time: m.commence_time,
            sharp_shift: agg,
            magnitude,
            book_count: rows.length,
            sharp_book_count: sharps.length,
          };
        });
        moves.sort((a, b) => b.magnitude - a.magnitude);

        return jsonResponse({ generated_at: nowIso, count: moves.length, moves });
      },
    },
  },
});