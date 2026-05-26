import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, PlayCircle } from "lucide-react";
import { getBacktest } from "@/lib/backtest.functions";
import { getUserSettings } from "@/lib/bets.functions";

export const Route = createFileRoute("/_authenticated/backtest")({
  head: () => ({ meta: [{ title: "Backtest — BetMind Pro" }] }),
  component: BacktestPage,
});

const MARKET_LABEL: Record<string, string> = {
  h2h: "1X2", ou_2_5: "Over/Under 2.5", btts: "BTTS",
};
const TIER_STYLE: Record<string, string> = {
  S: "bg-primary text-primary-foreground",
  A: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
  B: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  C: "bg-muted text-muted-foreground border border-border",
};

function BacktestPage() {
  const run = useServerFn(getBacktest);
  const fetchSettings = useServerFn(getUserSettings);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => fetchSettings() });
  const [enabled, setEnabled] = useState(false);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["backtest", settings?.tracked_leagues],
    queryFn: () => run({ data: { leagues: settings?.tracked_leagues } }),
    enabled,
    staleTime: 1000 * 60 * 10,
  });

  function start() {
    setEnabled(true);
    refetch();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Historical Backtest</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Walk-forward simulation against real cached results. For every finished match we
            re-fit Dixon-Coles on the prior history of that league only, pick the model's
            preferred side, and compare to the actual outcome. ROI is estimated assuming
            you obtained odds at fair value minus a 5% bookmaker margin.
          </p>
        </div>
        <Button onClick={start} disabled={isFetching}>
          {isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
          {isFetching ? "Running…" : data ? "Re-run" : "Run backtest"}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {(error as Error).message}
        </div>
      )}

      {!data && !isFetching && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Click <span className="font-mono-num">Run backtest</span> to simulate every cached historical match across your tracked leagues.
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Stat label="Matches in sample" value={data.totalMatches.toLocaleString()} />
            <Stat label="Leagues covered" value={String(data.leagues.length)} />
            <Stat label="Margin assumed" value={`${(data.marginAssumed * 100).toFixed(0)}%`} />
          </div>

          <Section title="Per-market summary">
            <TableEl headers={["Market", "Picks", "Hit rate", "Brier", "Est. ROI"]}>
              {data.totals.map((r) => (
                <tr key={r.market} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{MARKET_LABEL[r.market] ?? r.market}</td>
                  <td className="px-3 py-2 text-right font-mono-num">{r.picks.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono-num">{(r.hitRate * 100).toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right font-mono-num text-muted-foreground">{r.brier.toFixed(3)}</td>
                  <td className={`px-3 py-2 text-right font-mono-num ${r.roiPct >= 0 ? "text-primary" : "text-destructive"}`}>
                    {r.roiPct >= 0 ? "+" : ""}{r.roiPct.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </TableEl>
          </Section>

          <Section title="By confidence tier">
            <TableEl headers={["Market", "Tier", "Picks", "Hit rate", "Brier", "Est. ROI"]}>
              {data.rows.map((r) => (
                <tr key={`${r.market}-${r.tier}`} className="border-t border-border">
                  <td className="px-3 py-2">{MARKET_LABEL[r.market] ?? r.market}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold ${TIER_STYLE[r.tier]}`}>{r.tier}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num">{r.picks.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono-num">{(r.hitRate * 100).toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right font-mono-num text-muted-foreground">{r.brier.toFixed(3)}</td>
                  <td className={`px-3 py-2 text-right font-mono-num ${r.roiPct >= 0 ? "text-primary" : "text-destructive"}`}>
                    {r.roiPct >= 0 ? "+" : ""}{r.roiPct.toFixed(2)}%
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">No samples — historical results table is empty. Run Refresh on the dashboard first.</td></tr>
              )}
            </TableEl>
          </Section>

          <p className="text-xs text-muted-foreground">
            <Badge variant="outline" className="mr-2">Note</Badge>
            Brier score: lower is better calibration (0 = perfect, 0.25 = random coin-flip for a binary outcome).
            ROI is an estimate against fair-value-minus-margin synthetic prices; real betting markets differ.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono-num text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="overflow-hidden rounded-lg border border-border">{children}</div>
    </div>
  );
}

function TableEl({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
        <tr>{headers.map((h, i) => <th key={h} className={`px-3 py-2 ${i === 0 || i === 1 ? "text-left" : "text-right"}`}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}