import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runRefresh } from "./refresh.server";

/** Public: list value bets joined with match info, ordered by edge. */
export const getBets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("bets")
      .select("*, matches(id, home, away, commence_time, league, sport_key)")
      .order("edge_pct", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getSharpAlerts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("bets")
      .select("*, matches(id, home, away, commence_time, league)")
      .eq("sharp_alert", true)
      .order("edge_pct", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getUserSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("user_settings").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

const settingsSchema = z.object({
  bankroll: z.number().min(0).max(10_000_000),
  kelly_fraction: z.number().min(0).max(1),
  min_edge: z.number().min(0).max(1),
  max_stake_pct: z.number().min(0).max(1),
  max_daily_bets: z.number().int().min(1).max(100),
  tracked_leagues: z.array(z.string().min(1).max(64)).max(20),
});

export const updateSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => settingsSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("user_settings").update({ ...data, updated_at: new Date().toISOString() }).eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getBankrollHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("bankroll_history").select("date, balance, pnl").eq("user_id", userId).order("date");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/** Manual refresh trigger from the UI. */
export const triggerRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: settings } = await context.supabase
      .from("user_settings").select("tracked_leagues").eq("user_id", context.userId).maybeSingle();
    const leagues = settings?.tracked_leagues?.length ? settings.tracked_leagues : undefined;
    return await runRefresh(leagues);
  });
