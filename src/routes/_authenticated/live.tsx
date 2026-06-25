import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLiveValueBets } from "@/lib/live.functions";
import { getUserSettings } from "@/lib/bets.functions";
import { Loader2, RadioTower } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/live")({
  head: () => ({ meta: [{ title: "Live EV — BetMind Pro" }] }),
  component: LivePage,
});

function LivePage() {
  const fetchLive = useServerFn(getLiveValueBets);
  const fetchSettings = useServerFn(getUserSettings);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => fetchSettings() });

  const { data, isFetching, error, dataUpdatedAt } = useQuery({
    queryKey: ["live", settings?.tracked_leagues],
    queryFn: () => fetchLive({ data: { leagues: settings?.tracked_leagues } }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  const bets = data?.bets ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <RadioTower className={`h-5 w-5 ${isFetching ? "animate-pulse text-emerald-400" : "text-primary"}`} />
            Live In-Play EV
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Bayesian update of the pre-match Dixon-Coles model using current score and elapsed minutes.
            Auto-refreshes every 15s. <span className="text-emerald-400">Green</span> rows have EV ≥ 5%.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : "—"}
          {isFetching && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {(error as Error).message}
        </div>
      )}
      {data?.errors && data.errors.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-300">
          {data.errors.slice(0, 3).map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {bets.length === 0 && !isFetching && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No live matches with cached odds right now. Run the dashboard <span className="font-mono-num">Refresh</span> first
          so odds are stored, then come back when matches kick off.
        </div>
      )}

      {bets.length > 0 && (
        <div className="space-y-3">
          {bets.map((b) => (
            <div key={b.matchId} className={`rounded-lg border p-4 ${b.evPct >= 0.05 ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-card"}`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium">{b.home} <span className="text-muted-foreground">vs</span> {b.away}</div>
                  <div className="text-xs text-muted-foreground">{b.league}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono-num text-lg font-semibold">{b.scoreHome}–{b.scoreAway}</div>
                  <div className="text-xs text-muted-foreground">{b.minute}′</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                <Badge variant="outline">{b.marketLabel}</Badge>
                <span className="font-medium">{b.selectionLabel}</span>
                <span className="font-mono-num">@ {b.bestOdds.toFixed(2)}</span>
                <span className="text-xs text-muted-foreground">{b.bookmaker}</span>
                <span className="font-mono-num">Model {(b.modelProb * 100).toFixed(1)}%</span>
                <span className={`font-mono-num font-semibold ${b.evPct >= 0.05 ? "text-emerald-400" : b.evPct >= 0 ? "text-primary" : "text-muted-foreground"}`}>
                  EV {b.evPct >= 0 ? "+" : ""}{(b.evPct * 100).toFixed(2)}%
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border/50 pt-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Top scores:</span>
                {b.topScores.map((s, i) => (
                  <span key={i} className="rounded border border-border bg-muted/30 px-2 py-0.5 font-mono-num text-xs">
                    {s.home}–{s.away} <span className="text-muted-foreground">{(s.prob * 100).toFixed(1)}%</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Statistical estimates only. No outcome is guaranteed. Bet responsibly and in accordance with your local laws.
      </p>
    </div>
  );
}