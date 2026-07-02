import { useState } from "react";
import { ChevronDown } from "lucide-react";

type Layers = {
  poisson?: number;
  dixonColes?: number;
  elo?: number;
  formFeatures?: number;
  marketConsensus?: number;
  sharpVsSoftDelta?: number;
  lineMovement?: number;
  rawEnsembleProb?: number;
  calibratedProb?: number;
  calibration?: {
    method?: "platt" | "isotonic" | "identity";
    n?: number;
    brierRaw?: number;
    brierCal?: number;
  };
};

// Layer weights kept in sync with ensemble.server.ts. If those change, mirror here.
const WEIGHTS: Record<string, number> = {
  marketConsensus: 0.55,
  dixonColes: 0.13,
  sharpVsSoftDelta: 0.12,
  elo: 0.07,
  poisson: 0.06,
  formFeatures: 0.06,
  lineMovement: 0.05,
};

const LABEL: Record<string, string> = {
  marketConsensus: "Sharp market consensus",
  dixonColes: "Dixon-Coles (xG Poisson)",
  sharpVsSoftDelta: "Sharp vs soft divergence",
  elo: "Elo rating",
  poisson: "Poisson (market-seeded)",
  formFeatures: "Recent form (rolling)",
  lineMovement: "Line movement (open→now)",
};

export function ConfidenceBreakdown({
  layers,
  aiProb,
  edgePct,
  kellyPct,
  rationale,
}: {
  layers: Layers | null | undefined;
  aiProb: number;
  edgePct: number;
  kellyPct: number;
  rationale: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (!layers) {
    return (
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
        Why
      </button>
    );
  }

  const rows = Object.keys(WEIGHTS)
    .map((k) => ({
      key: k,
      label: LABEL[k],
      weight: WEIGHTS[k],
      value: Number(layers[k as keyof Layers] ?? 0),
    }))
    .sort((a, b) => b.weight - a.weight);

  const raw = Number(layers.rawEnsembleProb ?? aiProb);
  const cal = Number(layers.calibratedProb ?? aiProb);
  const calDelta = cal - raw;
  const calib = layers.calibration;
  const brierGain =
    calib && Number.isFinite(calib.brierRaw) && Number.isFinite(calib.brierCal)
      ? (calib.brierRaw as number) - (calib.brierCal as number)
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
        {open ? "Hide" : "Why"}
      </button>
      {open && (
        <div className="mt-2 rounded border border-border bg-muted/20 p-3 text-xs">
          <div className="mb-2 flex flex-wrap gap-4 font-mono-num">
            <span>Raw ensemble: <span className="text-foreground">{(raw * 100).toFixed(1)}%</span></span>
            <span>
              Calibrated:{" "}
              <span className="text-foreground">{(cal * 100).toFixed(1)}%</span>
              {Math.abs(calDelta) >= 0.005 && (
                <span className={calDelta >= 0 ? "ml-1 text-emerald-400" : "ml-1 text-amber-400"}>
                  ({calDelta >= 0 ? "+" : ""}{(calDelta * 100).toFixed(1)} pts)
                </span>
              )}
            </span>
            <span>Edge: <span className="text-primary">+{(edgePct * 100).toFixed(2)}%</span></span>
            <span>Kelly: <span className="text-foreground">{(kellyPct * 100).toFixed(2)}%</span> bankroll</span>
          </div>
          {calib && (
            <div className="mb-3 rounded border border-border/40 bg-background/40 px-2 py-1.5 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Calibration:</span>{" "}
              <span className="uppercase tracking-wide">{calib.method ?? "identity"}</span>
              {typeof calib.n === "number" && (
                <span className="ml-2">fit on <span className="font-mono-num text-foreground">{calib.n}</span> settled bets</span>
              )}
              {brierGain !== null && (
                <span className="ml-2">
                  Brier{" "}
                  <span className="font-mono-num">{(calib.brierRaw as number).toFixed(3)}</span>
                  {" → "}
                  <span className="font-mono-num text-foreground">{(calib.brierCal as number).toFixed(3)}</span>
                  <span className={brierGain > 0 ? "ml-1 text-emerald-400" : "ml-1 text-amber-400"}>
                    ({brierGain > 0 ? "−" : "+"}{Math.abs(brierGain).toFixed(3)})
                  </span>
                </span>
              )}
              {calib.method === "identity" && (
                <span className="ml-2 italic">— not enough settled bets yet; probabilities pass through unchanged.</span>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            {rows.map((r) => {
              const isNudge = r.key === "sharpVsSoftDelta" || r.key === "lineMovement";
              const pct = isNudge ? Math.abs(r.value) : r.value;
              const barWidth = Math.min(100, Math.max(0, pct * 100));
              return (
                <div key={r.key} className="grid grid-cols-[1fr_auto] items-center gap-2">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className="font-mono-num text-[10px] text-muted-foreground">
                        weight {(r.weight * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-background">
                      <div
                        className={`h-full ${
                          isNudge
                            ? r.value >= 0
                              ? "bg-emerald-500/70"
                              : "bg-amber-500/70"
                            : "bg-primary/70"
                        }`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-14 text-right font-mono-num">
                    {isNudge
                      ? `${r.value >= 0 ? "+" : ""}${(r.value * 100).toFixed(1)}%`
                      : `${(r.value * 100).toFixed(1)}%`}
                  </div>
                </div>
              );
            })}
          </div>
          {rationale && (
            <div className="mt-3 border-t border-border/60 pt-2 text-muted-foreground">
              <span className="font-medium text-foreground">Rationale: </span>
              {rationale}
            </div>
          )}
        </div>
      )}
    </>
  );
}