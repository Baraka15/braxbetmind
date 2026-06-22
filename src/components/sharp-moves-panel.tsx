import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSharpMoves, type SharpMove } from "@/lib/sharp-moves.functions";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, Flame, Minus } from "lucide-react";

function fmtPct(x: number | null | undefined, digits = 1) {
  if (x == null || !isFinite(x)) return "—";
  const v = x * 100;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function DriftCell({ drift }: { drift: number | null }) {
  if (drift == null) return <span className="text-muted-foreground">—</span>;
  const arrow = drift < -0.001 ? <ArrowDown className="h-3 w-3" /> : drift > 0.001 ? <ArrowUp className="h-3 w-3" /> : <Minus className="h-3 w-3" />;
  // Price shortened (drift < 0) = money came in on this side → green.
  const cls = drift < -0.001 ? "text-emerald-300" : drift > 0.001 ? "text-rose-300" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-xs ${cls}`}>
      {arrow}
      {fmtPct(drift)}
    </span>
  );
}

export function SharpMovesPanel() {
  const fetchMoves = useServerFn(getSharpMoves);
  const { data, isLoading } = useQuery({
    queryKey: ["sharp-moves"],
    queryFn: () => fetchMoves(),
    refetchInterval: 60_000,
  });

  const moves: SharpMove[] = data?.moves ?? [];

  return (
    <section className="rounded-lg border border-border bg-card/50 p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Sharp Moves</h2>
          <p className="text-xs text-muted-foreground">
            Opening → current drift per book. Steam = sharp consensus shortening a side.
          </p>
        </div>
        {data?.generatedAt && (
          <span className="text-xs text-muted-foreground">
            {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading market drift…</p>
      ) : moves.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No upcoming matches with opening prices yet. Run a refresh to seed openings.
        </p>
      ) : (
        <div className="space-y-3">
          {moves.slice(0, 8).map((m) => (
            <article key={m.matchId} className="rounded-md border border-border/60 bg-background/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">
                    {m.home} <span className="text-muted-foreground">vs</span> {m.away}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {m.league ?? "—"} · {new Date(m.commenceTime).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {m.steam && (
                    <Badge className="gap-1 bg-amber-500/15 text-amber-300 border border-amber-500/40">
                      <Flame className="h-3 w-3" /> Steam on {m.steam}
                    </Badge>
                  )}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    Δ {(m.magnitude * 100).toFixed(1)}%
                  </Badge>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 rounded bg-muted/30 p-2 text-xs">
                <div>
                  <div className="text-muted-foreground">Sharp shift · Home</div>
                  <DriftCell drift={-m.sharpShift.home} />
                </div>
                <div>
                  <div className="text-muted-foreground">Draw</div>
                  <DriftCell drift={-m.sharpShift.draw} />
                </div>
                <div>
                  <div className="text-muted-foreground">Away</div>
                  <DriftCell drift={-m.sharpShift.away} />
                </div>
              </div>

              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-2 font-medium">Book</th>
                      <th className="py-1 pr-2 font-medium">Home</th>
                      <th className="py-1 pr-2 font-medium">Draw</th>
                      <th className="py-1 pr-2 font-medium">Away</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.books
                      .slice()
                      .sort((a, b) => Number(b.isSharp) - Number(a.isSharp))
                      .slice(0, 6)
                      .map((b) => (
                        <tr key={b.bookmaker} className="border-t border-border/40">
                          <td className="py-1 pr-2">
                            <span className="font-medium">{b.bookmaker}</span>
                            {b.isSharp && <Badge variant="outline" className="ml-1 px-1 py-0 text-[9px]">sharp</Badge>}
                          </td>
                          <td className="py-1 pr-2"><DriftCell drift={b.home.driftPct} /></td>
                          <td className="py-1 pr-2"><DriftCell drift={b.draw.driftPct} /></td>
                          <td className="py-1 pr-2"><DriftCell drift={b.away.driftPct} /></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}