import { createFileRoute } from "@tanstack/react-router";
import { authenticateApiRequest, corsPreflight, jsonResponse } from "@/lib/api-auth.server";

export const Route = createFileRoute("/api/public/v1/predictions")({
  server: {
    handlers: {
      OPTIONS: async () => corsPreflight(),
      GET: async ({ request }) => {
        const auth = await authenticateApiRequest(request);
        if ("error" in auth) return auth.error;

        const url = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
        const matchId = url.searchParams.get("match_id");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        let q = supabaseAdmin
          .from("predictions")
          .select("match_id, p_home, p_draw, p_away, source, created_at, matches(id, home, away, league, commence_time)")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (matchId) q = q.eq("match_id", matchId);
        const { data, error } = await q;
        if (error) return jsonResponse({ error: error.message }, 500);

        return jsonResponse({
          generated_at: new Date().toISOString(),
          count: data?.length ?? 0,
          predictions: data ?? [],
        });
      },
    },
  },
});