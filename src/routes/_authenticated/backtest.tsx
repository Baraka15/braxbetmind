import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, PlayCircle, Upload } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Legend } from "recharts";
import { getBacktest } from "@/lib/backtest.functions";
import { runCsvBacktestFn } from "@/lib/backtest-csv.functions";
import { getUserSettings } from "@/lib/bets.functions";
import { toast } from "sonner";

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
  const runCsv = useServerFn(runCsvBacktestFn);
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
      <div>
        <h1 className="text-xl font-semibold">Backtesting & Validation</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Validate the engine two ways: (1) walk-forward against the league results stored in your database,
          or (2) upload your own historical CSV with closing odds to see real equity curve, drawdown, Sharpe and calibration.
        </p>
      </div>

      <Tabs defaultValue="system" className="space-y-6">
        <TabsList>
          <TabsTrigger value="system">System (DB results)</TabsTrigger>
          <TabsTrigger value="csv">CSV upload</TabsTrigger>
        </TabsList>

        <TabsContent value="system" className="space-y-6">
          <div className="flex justify-end">
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
        </TabsContent>

        <TabsContent value="csv" className="space-y-6">
          <CsvBacktest runCsv={runCsv} />
        </TabsContent>
      </Tabs>
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

type CsvBacktestResult = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof runCsvBacktestFn>>>>;

function CsvBacktest({ runCsv }: { runCsv: ReturnType<typeof useServerFn<typeof runCsvBacktestFn>> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [params, setParams] = useState({ minEdge: 0.05, kellyFraction: 0.25, startingBankroll: 1000 });
  const [csv, setCsv] = useState<string>("");
  const [result, setResult] = useState<CsvBacktestResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    const text = await file.text();
    setCsv(text);
  }

  async function execute() {
    if (!csv) { toast.error("Upload a CSV first"); return; }
    setBusy(true);
    try {
      const r = await runCsv({ data: { csv, ...params } });
      setResult(r);
      toast.success(`Backtest done — ${r.bets} bets, ROI ${r.roiPct.toFixed(2)}%`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-semibold">Upload historical CSV</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Required columns: <span className="font-mono-num">date, home, away, home_odds, draw_odds, away_odds, home_score, away_score</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Field label="Min edge"><Input type="number" step="0.005" min="0" max="1" value={params.minEdge} onChange={(e) => setParams({ ...params, minEdge: +e.target.value })} /></Field>
          <Field label="Kelly fraction"><Input type="number" step="0.05" min="0" max="1" value={params.kellyFraction} onChange={(e) => setParams({ ...params, kellyFraction: +e.target.value })} /></Field>
          <Field label="Starting bankroll"><Input type="number" step="1" min="1" value={params.startingBankroll} onChange={(e) => setParams({ ...params, startingBankroll: +e.target.value })} /></Field>
          <div className="flex items-end gap-2">
            <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />{csv ? "Replace" : "Choose CSV"}
            </Button>
            <Button type="button" onClick={execute} disabled={busy || !csv}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}Run
            </Button>
            <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        </div>
        {csv && <div className="mt-3 text-xs text-muted-foreground">Loaded {(csv.length / 1024).toFixed(1)} KB</div>}
      </div>

      {result && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Stat label="Bets" value={`${result.bets}/${result.totalRows}`} />
            <Stat label="Hit rate" value={`${(result.hitRate * 100).toFixed(1)}%`} />
            <Stat label="ROI" value={`${result.roiPct >= 0 ? "+" : ""}${result.roiPct.toFixed(2)}%`} />
            <Stat label="Final bankroll" value={`$${result.finalBankroll.toFixed(0)}`} />
            <Stat label="Total P&L" value={`${result.totalPnlUnits >= 0 ? "+" : ""}$${result.totalPnlUnits.toFixed(2)}`} />
            <Stat label="Max drawdown" value={`${result.maxDrawdownPct.toFixed(1)}%`} />
            <Stat label="Sharpe" value={result.sharpe.toFixed(2)} />
            <Stat label="Brier" value={result.brier.toFixed(3)} />
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 text-sm font-semibold">Equity curve</div>
            <div className="h-64 w-full">
              <ResponsiveContainer>
                <LineChart data={result.equityCurve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="idx" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Line type="monotone" dataKey="bankroll" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 text-sm font-semibold">Calibration (predicted vs actual hit rate)</div>
            <div className="h-64 w-full">
              <ResponsiveContainer>
                <BarChart data={result.calibration}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={[0, 1]} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Legend />
                  <Bar dataKey="predicted" fill="hsl(var(--muted-foreground))" name="Predicted" />
                  <Bar dataKey="actual" fill="hsl(var(--primary))" name="Actual" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label className="text-xs">{label}</Label>{children}</div>;
}