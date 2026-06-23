import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Manual "Resync now" — re-runs the Football Data fetch for recent results
 * (Elo / Dixon-Coles / form) and re-builds today's value bets.
 */
export const resyncNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { runRefresh } = await import("./refresh.server");
    const started = Date.now();
    const summary = await runRefresh();
    return { ...summary, elapsedMs: Date.now() - started };
  });