/**
 * Honest performance metrics computed from real settled `bets`:
 *   - hit rate, ROI/unit
 *   - Brier score, log-loss
 *   - ECE (Expected Calibration Error, 10-bin)
 *   - average CLV %
 *
 * Also exposes recent steam signals for the dashboard.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const EPS = 1e-6;

function clip(p: number) { return Math.min(1 - EPS, Math.max(EPS, p)); }

function computeMetrics(rows: {
  ai_prob: number | null;
  status: string | null;
  pnl_units: number | null;
  clv_pct: number | null;
}[]) {
  const usable = rows.filter((r) =>
    (r.status === "won" || r.status === "lost") && r.ai_prob != null,
  );
  const n = usable.length;
  if (!n) {
    return { n_bets: 0, n_won: 0, hit_rate: 0, roi_pct: 0, brier: 0, log_loss: 0, ece: 0, avg_clv_pct: null };
  }
  let won = 0, brier = 0, logLoss = 0, pnl = 0;
  const clvs: number[] = [];
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const r of usable) {
    const p = clip(Number(r.ai_prob));
    const y = r.status === "won" ? 1 : 0;
    won += y;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    pnl += Number(r.pnl_units ?? 0);
    if (r.clv_pct != null) clvs.push(Number(r.clv_pct));
    const bIdx = Math.min(9, Math.floor(p * 10));
    bins[bIdx].p += p;
    bins[bIdx].y += y;
    bins[bIdx].n += 1;
  }
  let ece = 0;
  for (const b of bins) {
    if (!b.n) continue;
    const meanP = b.p / b.n;
    const meanY = b.y / b.n;
    ece += (b.n / n) * Math.abs(meanP - meanY);
  }
  const avg_clv_pct = clvs.length ? clvs.reduce((s, x) => s + x, 0) / clvs.length : null;
  return {
    n_bets: n,
    n_won: won,
    hit_rate: won / n,
    roi_pct: pnl / n,
    brier: brier / n,
    log_loss: logLoss / n,
    ece,
    avg_clv_pct,
  };
}

export const getPerformanceMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ windowDays: z.number().int().min(1).max(365).default(30) })
      .parse(input ?? { windowDays: 30 }),
  )
  .handler(async ({ context, data }) => {
    const since = new Date(Date.now() - data.windowDays * 86_400_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("bets")
      .select("ai_prob, status, pnl_units, clv_pct, market")
      .in("status", ["won", "lost"])
      .gte("settled_at", since)
      .limit(5000);
    if (error) throw new Error(error.message);
    const all = rows ?? [];
    const overall = computeMetrics(all);
    const byMarket: Record<string, ReturnType<typeof computeMetrics>> = {};
    const markets = new Set(all.map((r) => String(r.market ?? "h2h")));
    for (const m of markets) {
      byMarket[m] = computeMetrics(all.filter((r) => String(r.market ?? "h2h") === m));
    }
    return { windowDays: data.windowDays, overall, byMarket };
  });

export const getSteamSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data, error } = await context.supabase
      .from("steam_signals")
      .select("*, matches:match_id(home, away, league, commence_time)")
      .gte("detected_at", since)
      .order("detected_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return data ?? [];
  });