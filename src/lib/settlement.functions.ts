import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runSettlement } from "./settlement.server";

export const triggerSettlement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => runSettlement());

export const getSettlements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("bets")
      .select("id, match_id, market, selection, best_odds, ai_prob, implied_prob, edge_pct, status, actual_result, pnl_units, settled_at, matches(home, away, commence_time, league)")
      .in("status", ["won", "lost", "void"])
      .order("settled_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });