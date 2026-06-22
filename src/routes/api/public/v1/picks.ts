import { createFileRoute } from "@tanstack/react-router";
import { authenticateApiRequest, corsPreflight, jsonResponse } from "@/lib/api-auth.server";

export const Route = createFileRoute("/api/public/v1/picks")({
  server: {
    handlers: {
      OPTIONS: async () => corsPreflight(),
      GET: async ({ request }) => {
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;

        const url = new URL(request.url);
        const minEdge = Math.min(Math.max(parseFloat(url.searchParams.get("min_edge") ?? "0.02"), 0), 1);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "25", 10) || 25, 1), 100);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const nowIso = new Date().toISOString();
        const { data, error } = await supabaseAdmin
          .from("bets")
          .select("id, outcome, market, selection, confidence_tier, best_odds, bookmaker, ai_prob, implied_prob, edge_pct, kelly_stake_pct, sharp_alert, matches(id, home, away, league, sport_key, commence_time)")
          .eq("status", "pending")
          .gte("edge_pct", minEdge)
          .gt("matches.commence_time", nowIso)
          .order("edge_pct", { ascending: false })
          .limit(limit);
        if (error) return jsonResponse({ error: error.message }, 500);

        const picks = (data ?? []).filter((b: { matches: unknown }) => b.matches);
        return jsonResponse({
          generated_at: nowIso,
          count: picks.length,
          picks: picks.map((p) => ({
            id: p.id,
            market: p.market,
            selection: p.selection,
            outcome: p.outcome,
            tier: p.confidence_tier,
            odds: p.best_odds,
            bookmaker: p.bookmaker,
            predicted_probability: p.ai_prob,
            implied_probability: p.implied_prob,
            edge: p.edge_pct,
            kelly_stake_pct: p.kelly_stake_pct,
            sharp_alert: p.sharp_alert,
            match: p.matches,
          })),
        });
      },
    },
  },
});