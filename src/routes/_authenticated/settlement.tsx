import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { CheckCircle2, XCircle, MinusCircle, RefreshCw } from "lucide-react";
import { getSettlements, triggerSettlement } from "@/lib/settlement.functions";

export const Route = createFileRoute("/_authenticated/settlement")({
  head: () => ({ meta: [{ title: "Settlement — BetMind Pro" }] }),
  component: SettlementPage,
});

type Row = {
  id: string; market: string; selection: string | null;
  best_odds: number; ai_prob: number; implied_prob: number; edge_pct: number;
  status: "won" | "lost" | "void";
  actual_result: string | null;
  pnl_units: number;
  settled_at: string | null;
  matches: { home: string; away: string; commence_time: string; league: string | null } | null;
};

function SettlementPage() {
  const qc = useQueryClient();
  const fetchRows = useServerFn(getSettlements);
  const settle = useServerFn(triggerSettlement);
  const { data: rows = [] } = useQuery({ queryKey: ["settlements"], queryFn: () => fetchRows() });

  const stats = useMemo(() => {
    const list = rows as Row[];
    const settled = list.filter((r) => r.status !== "void");
    const won = list.filter((r) => r.status === "won").length;
    const lost = list.filter((r) => r.status === "lost").length;
    const voids = list.filter((r) => r.status === "void").length;
    const realized = list.reduce((s, r) => s + Number(r.pnl_units), 0);
    const expected = list.reduce((s, r) => s + Number(r.edge_pct), 0);
    const hit = settled.length ? (won / settled.length) * 100 : 0;
    const roi = settled.length ? (realized / settled.length) * 100 : 0;
    return { won, lost, voids, realized, expected, hit, roi, total: list.length };
  }, [rows]);

  async function run() {
    toast.info("Settling completed matches…");
    try {
      const res = await settle();
      toast.success(`Settled ${res.settled} (W:${res.won} L:${res.lost} V:${res.void}) · ${res.missing} pending result`);
      qc.invalidateQueries({ queryKey: ["settlements"] });
      qc.invalidateQueries({ queryKey: ["bets"] });
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Settled" value={`${stats.total}`} />
        <Stat label="Hit rate" value={`${stats.hit.toFixed(1)}%`} />
        <Stat label="Realized P&L" value={`${stats.realized >= 0 ? "+" : ""}${stats.realized.toFixed(2)}u`} positive={stats.realized >= 0} />
        <Stat label="ROI / bet" value={`${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(2)}%`} positive={stats.roi >= 0} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">Realized vs Expected</div>
          <div className="mt-2 flex items-baseline gap-3 font-mono-num">
            <span className="text-2xl">{stats.realized.toFixed(2)}u</span>
            <span className="text-sm text-muted-foreground">model EV: {(stats.expected).toFixed(2)}u</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Edge realized: {(stats.realized - stats.expected).toFixed(2)}u vs prediction
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Settle now</div>
            <div className="mt-1 text-sm text-muted-foreground">Marks every bet whose match has finished.</div>
          </div>
          <Button onClick={run}><RefreshCw className="mr-2 h-4 w-4" />Run settlement</Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Match</th>
              <th className="px-3 py-2 text-left">Pick</th>
              <th className="px-3 py-2 text-left">Result</th>
              <th className="px-3 py-2 text-center">Status</th>
              <th className="px-3 py-2 text-right">Odds</th>
              <th className="px-3 py-2 text-right">Edge</th>
              <th className="px-3 py-2 text-right">P&L (u)</th>
            </tr>
          </thead>
          <tbody>
            {(rows as Row[]).length === 0 && (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No settled bets yet. Click <span className="font-mono-num">Run settlement</span>.</td></tr>
            )}
            {(rows as Row[]).map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono-num text-xs text-muted-foreground">
                  {r.settled_at ? new Date(r.settled_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">{r.matches?.home} vs {r.matches?.away}</div>
                  <div className="text-xs text-muted-foreground">{r.matches?.league}</div>
                </td>
                <td className="px-3 py-2"><Badge variant="outline">{r.market} · {r.selection}</Badge></td>
                <td className="px-3 py-2 font-mono-num text-xs">{r.actual_result ?? "—"}</td>
                <td className="px-3 py-2 text-center">
                  {r.status === "won" && <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-400" />}
                  {r.status === "lost" && <XCircle className="mx-auto h-4 w-4 text-destructive" />}
                  {r.status === "void" && <MinusCircle className="mx-auto h-4 w-4 text-muted-foreground" />}
                </td>
                <td className="px-3 py-2 text-right font-mono-num">{Number(r.best_odds).toFixed(2)}</td>
                <td className="px-3 py-2 text-right font-mono-num text-primary">+{(Number(r.edge_pct) * 100).toFixed(2)}%</td>
                <td className={`px-3 py-2 text-right font-mono-num ${Number(r.pnl_units) > 0 ? "text-emerald-400" : Number(r.pnl_units) < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                  {Number(r.pnl_units) >= 0 ? "+" : ""}{Number(r.pnl_units).toFixed(2)}
                </td>
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
      <div className={`mt-1 font-mono-num text-2xl font-semibold ${positive === true ? "text-emerald-400" : positive === false ? "text-destructive" : ""}`}>{value}</div>
    </div>
  );
}