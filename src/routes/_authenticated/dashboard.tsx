import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo } from "react";
import { getBets, getUserSettings, triggerRefresh, getAccuracyStats } from "@/lib/bets.functions";
import { sendTelegramAlerts } from "@/lib/telegram.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle, Send } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SharpMovesPanel } from "@/components/sharp-moves-panel";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — BetMind Pro" }] }),
  component: Dashboard,
});

type Bet = {
  id: string; match_id: string; outcome: string;
  market: string; selection: string;
  confidence_tier: "S" | "A" | "B" | "C";
  rationale: string | null;
  best_odds: number; bookmaker: string; ai_prob: number; implied_prob: number;
  edge_pct: number; kelly_stake_pct: number; sharp_alert: boolean;
  matches: { home: string; away: string; commence_time: string; league: string | null } | null;
};

const MARKET_LABEL: Record<string, string> = {
  h2h: "1X2", ou_1_5: "O/U 1.5", ou_2_5: "O/U 2.5", ou_3_5: "O/U 3.5",
  btts: "BTTS", dc: "Double Chance", dnb: "Draw No Bet",
};
const SELECTION_LABEL: Record<string, string> = {
  home: "Home", draw: "Draw", away: "Away",
  over: "Over", under: "Under", yes: "Yes", no: "No",
  "1X": "Home/Draw", "12": "Home/Away", X2: "Draw/Away",
};
const TIER_STYLE: Record<string, string> = {
  S: "bg-primary text-primary-foreground",
  A: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
  B: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  C: "bg-muted text-muted-foreground border border-border",
};

function Dashboard() {
  const qc = useQueryClient();
  const fetchBets = useServerFn(getBets);
  const fetchSettings = useServerFn(getUserSettings);
  const refresh = useServerFn(triggerRefresh);
  const sendAlerts = useServerFn(sendTelegramAlerts);
  const fetchAccuracy = useServerFn(getAccuracyStats);

  const { data: bets = [] } = useQuery({ queryKey: ["bets"], queryFn: () => fetchBets(), refetchInterval: 60_000 });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => fetchSettings() });
  const { data: acc } = useQuery({ queryKey: ["accuracy"], queryFn: () => fetchAccuracy(), refetchInterval: 120_000 });

  useEffect(() => {
    const ch = supabase.channel("bets-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "bets" }, () => {
        qc.invalidateQueries({ queryKey: ["bets"] });
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const sharp = useMemo(() => (bets as Bet[]).filter((b) => b.sharp_alert), [bets]);
  const bankroll = Number(settings?.bankroll ?? 0);
  const totalStake = (bets as Bet[]).reduce((s, b) => s + b.kelly_stake_pct * bankroll, 0);
  const ev = (bets as Bet[]).reduce((s, b) => s + b.edge_pct * (b.kelly_stake_pct * bankroll), 0);

  async function runRefresh() {
    toast.info("Scanning sharp books…");
    try {
      const res = await refresh();
      toast.success(`Refreshed — ${res.matches} matches, ${res.bets} value bets`);
      qc.invalidateQueries();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function pushAlerts() {
    try {
      const r = await sendAlerts({ data: { force: false } });
      if (r.sent === 0) toast.info(`No new bets above threshold (${r.candidates} candidates).`);
      else toast.success(`Sent ${r.sent} alert${r.sent === 1 ? "" : "s"} to Telegram.`);
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="space-y-6">
      <AccuracyTicker acc={acc} />
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Bankroll" value={`$${bankroll.toFixed(2)}`} />
        <Stat label="Open bets" value={String((bets as Bet[]).length)} />
        <Stat label="Total stake" value={`$${totalStake.toFixed(2)}`} />
        <Stat label="Expected value" value={`$${ev.toFixed(2)}`} positive />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Value Bets</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={pushAlerts}><Send className="mr-2 h-4 w-4" />Telegram alerts</Button>
          <Button size="sm" onClick={runRefresh}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
        </div>
      </div>

      {sharp.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" /> Sharp Money Alerts ({sharp.length})
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {sharp.slice(0, 6).map((b) => (
              <div key={b.id} className="animate-pulse-alert rounded border border-destructive/30 bg-card p-3 text-sm">
                <div className="font-medium">{b.matches?.home} vs {b.matches?.away}</div>
                <div className="font-mono-num text-xs text-muted-foreground">{b.outcome.toUpperCase()} @ {b.best_odds.toFixed(2)} · edge {(b.edge_pct * 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <SharpMovesPanel />

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Kickoff</th>
              <th className="px-3 py-2 text-left">Match</th>
              <th className="px-3 py-2 text-left">Market</th>
              <th className="px-3 py-2 text-left">Pick</th>
              <th className="px-3 py-2 text-center">Tier</th>
              <th className="px-3 py-2 text-right">Odds</th>
              <th className="px-3 py-2 text-right">AI %</th>
              <th className="px-3 py-2 text-right">Implied %</th>
              <th className="px-3 py-2 text-right">Edge</th>
              <th className="px-3 py-2 text-right">Stake</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {(bets as Bet[]).length === 0 && (
              <tr><td colSpan={11} className="px-3 py-12 text-center text-muted-foreground">No value bets yet. Click <span className="font-mono-num">Refresh</span> to scan.</td></tr>
            )}
            {(bets as Bet[]).map((b) => (
              <tr key={b.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono-num text-xs text-muted-foreground">{b.matches ? new Date(b.matches.commence_time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                <td className="px-3 py-2">
                  <div className="font-medium">{b.matches?.home} <span className="text-muted-foreground">vs</span> {b.matches?.away}</div>
                  <div className="text-xs text-muted-foreground">{b.matches?.league}</div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{MARKET_LABEL[b.market] ?? b.market}</td>
                <td className="px-3 py-2"><Badge variant="outline">{SELECTION_LABEL[b.selection] ?? b.selection}</Badge></td>
                <td className="px-3 py-2 text-center">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className={`inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold ${TIER_STYLE[b.confidence_tier] ?? TIER_STYLE.C}`}>{b.confidence_tier}</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs">{b.rationale ?? "—"}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </td>
                <td className="px-3 py-2 text-right font-mono-num">{b.best_odds.toFixed(2)} <span className="text-xs text-muted-foreground">{b.bookmaker}</span></td>
                <td className="px-3 py-2 text-right font-mono-num">{(b.ai_prob * 100).toFixed(1)}%</td>
                <td className="px-3 py-2 text-right font-mono-num text-muted-foreground">{(b.implied_prob * 100).toFixed(1)}%</td>
                <td className="px-3 py-2 text-right font-mono-num text-primary">+{(b.edge_pct * 100).toFixed(2)}%</td>
                <td className="px-3 py-2 text-right font-mono-num">${(b.kelly_stake_pct * bankroll).toFixed(2)}</td>
                <td className="px-3 py-2 text-right"><Button size="sm" variant="outline" disabled>Place</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono-num text-2xl font-semibold ${positive ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}

type Accuracy = {
  windowDays: number; edgeThreshold: number; sampleSize: number;
  hitRate: number | null; roiPerUnit: number | null;
  overallSample: number; overallHitRate: number | null;
};

function AccuracyTicker({ acc }: { acc: Accuracy | undefined }) {
  if (!acc) return null;
  const enough = acc.sampleSize >= 25;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        <span className="font-medium">Live model accuracy</span>
        <span className="text-xs text-muted-foreground">rolling {acc.windowDays}d · settled bets only</span>
      </div>
      <div className="flex items-center gap-6 font-mono-num">
        <div>
          <span className="text-xs text-muted-foreground mr-1">Hit-rate @ edge ≥ {Math.round(acc.edgeThreshold * 100)}%:</span>
          {enough && acc.hitRate != null ? (
            <span className="text-emerald-400">{(acc.hitRate * 100).toFixed(1)}%</span>
          ) : (
            <span className="text-muted-foreground">n/a</span>
          )}
          <span className="ml-1 text-xs text-muted-foreground">(n={acc.sampleSize})</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground mr-1">ROI/unit:</span>
          {enough && acc.roiPerUnit != null ? (
            <span className={acc.roiPerUnit >= 0 ? "text-emerald-400" : "text-destructive"}>
              {acc.roiPerUnit >= 0 ? "+" : ""}{(acc.roiPerUnit * 100).toFixed(2)}%
            </span>
          ) : (
            <span className="text-muted-foreground">n/a</span>
          )}
        </div>
      </div>
    </div>
  );
}