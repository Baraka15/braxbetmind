import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendTelegramMessage, formatAlertMessage, type AlertBet } from "./telegram.server";

/** Send a test message to verify the user's chat_id is correctly set. */
export const sendTelegramTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: settings, error } = await supabase
      .from("user_settings").select("telegram_chat_id").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    const chatId = settings?.telegram_chat_id?.trim();
    if (!chatId) throw new Error("No Telegram chat ID set. Save your chat ID in Settings first.");
    await sendTelegramMessage(
      chatId,
      "<b>✅ BetMind Pro</b>\nTelegram alerts are connected. You'll receive value-bet picks here.",
    );
    return { ok: true };
  });

/** Push every current pending value bet above the user's telegram_min_edge
 *  that hasn't been alerted yet. Called manually from the dashboard. */
export const sendTelegramAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ force: z.boolean().optional() }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: settings, error: sErr } = await supabase
      .from("user_settings")
      .select("telegram_chat_id, telegram_min_edge, last_telegram_alert_at")
      .eq("user_id", userId).maybeSingle();
    if (sErr) throw new Error(sErr.message);
    const chatId = settings?.telegram_chat_id?.trim();
    if (!chatId) throw new Error("No Telegram chat ID set. Save your chat ID in Settings first.");

    const minEdge = Number(settings?.telegram_min_edge ?? 0.05);
    const since = data.force ? new Date(0).toISOString() : (settings?.last_telegram_alert_at ?? new Date(Date.now() - 24 * 3600_000).toISOString());

    const { data: bets, error: bErr } = await supabaseAdmin
      .from("bets")
      .select("market, selection, best_odds, bookmaker, ai_prob, edge_pct, kelly_stake_pct, confidence_tier, created_at, matches!inner(home, away, league, commence_time)")
      .eq("status", "pending")
      .gte("edge_pct", minEdge)
      .gt("created_at", since)
      .gt("matches.commence_time", new Date().toISOString())
      .order("edge_pct", { ascending: false })
      .limit(15);
    if (bErr) throw new Error(bErr.message);

    let sent = 0;
    for (const b of bets ?? []) {
      const m = b.matches as unknown as { home: string; away: string; league: string | null; commence_time: string };
      const alert: AlertBet = {
        home: m.home, away: m.away, league: m.league, commence_time: m.commence_time,
        market: b.market, selection: b.selection ?? "—",
        best_odds: Number(b.best_odds), bookmaker: b.bookmaker,
        ai_prob: Number(b.ai_prob), edge_pct: Number(b.edge_pct),
        kelly_stake_pct: Number(b.kelly_stake_pct), confidence_tier: b.confidence_tier,
      };
      try { await sendTelegramMessage(chatId, formatAlertMessage(alert)); sent++; }
      catch { /* ignore individual failures so one bad msg doesn't block the rest */ }
    }

    await supabase.from("user_settings")
      .update({ last_telegram_alert_at: new Date().toISOString() })
      .eq("user_id", userId);

    return { sent, candidates: bets?.length ?? 0 };
  });