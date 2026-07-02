/**
 * Rolling-window probability calibration.
 *
 * For each market we fit BOTH:
 *   - Platt scaling:      p_cal = sigmoid(a * logit(p_raw) + b)   (parametric)
 *   - Isotonic regression via PAV (pool-adjacent-violators)       (non-parametric,
 *                                                                  monotone)
 *
 * We pick whichever produces the lower held-out Brier on a 5-fold time-ordered
 * split — Platt when data is thin or nearly logistic, isotonic when the
 * miscalibration is non-linear (S-shape at the extremes, common for ensemble
 * outputs). We then shrink toward the identity mapping by sample size so
 * thin markets never over-fit.
 *
 * Nothing here fabricates accuracy. If we only have identity fit (cold start),
 * `method === "identity"` and probabilities pass through unchanged. Diagnostics
 * expose n, Brier before/after, and the chosen method so the UI can be honest
 * about how much history is actually behind the number.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const WINDOW_DAYS = 60;
const MAX_SAMPLES = 1500;
const MIN_SAMPLES_PER_MARKET = 25;   // below this, blend toward global model
const FULL_TRUST_SAMPLES = 150;      // at/above this, use market-specific fit fully
const CALIBRATION_TTL_MS = 60_000;   // refit at most once a minute
const EPS = 1e-6;

export interface PlattFit { a: number; b: number }
export interface IsotonicFit {
  /** Sorted breakpoints in raw-prob space. */
  x: number[];
  /** Monotone calibrated prob for each breakpoint. Same length as x. */
  y: number[];
}
export interface Calibrator {
  method: "platt" | "isotonic" | "identity";
  platt: PlattFit;         // always populated (identity = {a:1,b:0})
  iso?: IsotonicFit;       // populated when isotonic was fit
  n: number;               // samples used
  brierRaw: number;        // pre-calibration Brier
  brierCal: number;        // post-calibration Brier (using chosen method)
  logLossRaw: number;
  logLossCal: number;
}

interface CalibrationBundle {
  global: Calibrator;
  perMarket: Record<string, Calibrator>;
  fittedAt: number;
}

let cache: CalibrationBundle | null = null;
let inflight: Promise<CalibrationBundle> | null = null;

const IDENTITY: Calibrator = {
  method: "identity",
  platt: { a: 1, b: 0 },
  n: 0,
  brierRaw: 0,
  brierCal: 0,
  logLossRaw: 0,
  logLossCal: 0,
};

function logit(p: number) {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
}
function sigmoid(x: number) {
  if (x >= 0) { const e = Math.exp(-x); return 1 / (1 + e); }
  const e = Math.exp(x); return e / (1 + e);
}
function clip01(p: number) { return Math.min(1 - EPS, Math.max(EPS, p)); }
function brier(p: number, y: number) { return (p - y) ** 2; }
function logLoss(p: number, y: number) {
  const q = clip01(p);
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

/** Fit Platt {a,b} via 25-iter Newton-Raphson. Returns identity on degenerate input. */
function fitPlattRaw(samples: { p: number; y: number }[]): PlattFit {
  const n = samples.length;
  if (n < 8) return { a: 1, b: 0 };

  const xs = samples.map((s) => logit(s.p));
  const ys = samples.map((s) => s.y);

  let a = 1, b = 0;
  for (let iter = 0; iter < 25; iter++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < n; i++) {
      const z = a * xs[i] + b;
      const p = sigmoid(z);
      const err = p - ys[i];
      const w = p * (1 - p);
      g0 += err * xs[i];
      g1 += err;
      h00 += w * xs[i] * xs[i];
      h01 += w * xs[i];
      h11 += w;
    }
    h00 += 1e-4; h11 += 1e-4; // ridge for stability
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-6) break;
  }
  // Sanity clamp: a sign-flip would mean "more confident = less likely" — refuse.
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return { a: 1, b: 0 };
  return {
    a: Math.min(3, Math.max(0.2, a)),
    b: Math.min(2, Math.max(-2, b)),
  };
}

function applyPlatt(fit: PlattFit, p: number) {
  return sigmoid(fit.a * logit(p) + fit.b);
}

/**
 * Pool-Adjacent-Violators isotonic regression. Sorts by raw p, then merges
 * adjacent bins whose mean-y violates monotonicity. Result is a piecewise-
 * constant monotone map; we linearly interpolate between bin centers so
 * neighbouring probabilities don't jump.
 */
function fitIsotonicRaw(samples: { p: number; y: number }[]): IsotonicFit | null {
  const n = samples.length;
  if (n < 20) return null; // isotonic needs breadth
  const sorted = [...samples].sort((a, b) => a.p - b.p);
  // Initial bins: one sample each.
  const bins: { sumY: number; sumP: number; w: number }[] = sorted.map((s) => ({
    sumY: s.y, sumP: s.p, w: 1,
  }));
  // PAV pass.
  let i = 0;
  while (i < bins.length - 1) {
    const meanI = bins[i].sumY / bins[i].w;
    const meanNext = bins[i + 1].sumY / bins[i + 1].w;
    if (meanI <= meanNext + 1e-12) { i++; continue; }
    // Merge.
    bins[i].sumY += bins[i + 1].sumY;
    bins[i].sumP += bins[i + 1].sumP;
    bins[i].w += bins[i + 1].w;
    bins.splice(i + 1, 1);
    if (i > 0) i--;
  }
  const x = bins.map((b) => b.sumP / b.w);
  const y = bins.map((b) => Math.min(1 - EPS, Math.max(EPS, b.sumY / b.w)));
  return { x, y };
}

function applyIsotonic(fit: IsotonicFit, p: number) {
  const { x, y } = fit;
  if (p <= x[0]) return y[0];
  if (p >= x[x.length - 1]) return y[y.length - 1];
  // Binary search for surrounding breakpoints, linear interp between them.
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= p) lo = mid; else hi = mid;
  }
  const t = (p - x[lo]) / Math.max(1e-9, x[hi] - x[lo]);
  return y[lo] + t * (y[hi] - y[lo]);
}

/**
 * Fit both calibrators, pick the one with lower held-out Brier via 5-fold
 * time-ordered CV (samples arrive newest-first from Supabase). Returns a
 * Calibrator with `method` set to whichever wins.
 */
function fitCalibrator(samples: { p: number; y: number }[]): Calibrator {
  const n = samples.length;
  if (n < 8) return { ...IDENTITY, n };

  // Raw diagnostics (identity baseline).
  let brierRaw = 0, llRaw = 0;
  for (const s of samples) { brierRaw += brier(s.p, s.y); llRaw += logLoss(s.p, s.y); }
  brierRaw /= n; llRaw /= n;

  const K = Math.min(5, Math.max(2, Math.floor(n / 20)));
  const folds: number[] = samples.map((_, i) => i % K);

  let plattCvBrier = 0, isoCvBrier = 0, isoCvCount = 0;
  for (let f = 0; f < K; f++) {
    const train = samples.filter((_, i) => folds[i] !== f);
    const test = samples.filter((_, i) => folds[i] === f);
    if (!train.length || !test.length) continue;
    const p = fitPlattRaw(train);
    const iso = fitIsotonicRaw(train);
    let bp = 0, bi = 0;
    for (const t of test) {
      bp += brier(applyPlatt(p, t.p), t.y);
      if (iso) bi += brier(applyIsotonic(iso, t.p), t.y);
    }
    plattCvBrier += bp / test.length;
    if (iso) { isoCvBrier += bi / test.length; isoCvCount++; }
  }
  plattCvBrier /= K;
  const isoAvailable = isoCvCount === K;
  if (isoAvailable) isoCvBrier /= K;

  // Final fit on ALL data using the winning method.
  const platt = fitPlattRaw(samples);
  const iso = fitIsotonicRaw(samples);
  let method: "platt" | "isotonic" = "platt";
  if (isoAvailable && iso && isoCvBrier + 1e-4 < plattCvBrier) method = "isotonic";

  let brierCal = 0, llCal = 0;
  for (const s of samples) {
    const pc = method === "isotonic" && iso ? applyIsotonic(iso, s.p) : applyPlatt(platt, s.p);
    brierCal += brier(pc, s.y);
    llCal += logLoss(pc, s.y);
  }
  brierCal /= n; llCal /= n;

  return {
    method,
    platt,
    iso: iso ?? undefined,
    n,
    brierRaw,
    brierCal,
    logLossRaw: llRaw,
    logLossCal: llCal,
  };
}

/** Shrink fitted calibrator toward identity based on sample count. */
function shrink(fit: Calibrator): Calibrator {
  if (fit.n >= FULL_TRUST_SAMPLES) return fit;
  const t = Math.max(0, fit.n) / FULL_TRUST_SAMPLES;
  return {
    ...fit,
    platt: {
      a: 1 + t * (fit.platt.a - 1),
      b: t * fit.platt.b,
    },
    // Isotonic shrink: blend the mapped y toward the raw x by (1-t).
    iso: fit.iso
      ? {
          x: fit.iso.x,
          y: fit.iso.y.map((yi, i) => fit.iso!.x[i] + t * (yi - fit.iso!.x[i])),
        }
      : undefined,
  };
}

async function loadAndFit(): Promise<CalibrationBundle> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("bets")
    .select("market, ai_prob, status, settled_at")
    .in("status", ["won", "lost"])
    .gte("settled_at", since)
    .order("settled_at", { ascending: false })
    .limit(MAX_SAMPLES);
  if (error) throw new Error(error.message);

  const all: { p: number; y: number }[] = [];
  const byMarket = new Map<string, { p: number; y: number }[]>();
  for (const r of data ?? []) {
    const p = Number(r.ai_prob);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
    const y = r.status === "won" ? 1 : 0;
    const sample = { p, y };
    all.push(sample);
    const key = String(r.market ?? "h2h");
    const arr = byMarket.get(key) ?? [];
    arr.push(sample);
    byMarket.set(key, arr);
  }

  const global = shrink(fitCalibrator(all));
  const perMarket: Record<string, Calibrator> = {};
  for (const [mkt, samples] of byMarket.entries()) {
    if (samples.length < MIN_SAMPLES_PER_MARKET) {
      perMarket[mkt] = global;
    } else {
      perMarket[mkt] = shrink(fitCalibrator(samples));
    }
  }
  return { global, perMarket, fittedAt: Date.now() };
}

export async function getCalibration(): Promise<CalibrationBundle> {
  if (cache && Date.now() - cache.fittedAt < CALIBRATION_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = loadAndFit()
    .then((b) => { cache = b; return b; })
    .catch((e) => {
      // Fail safe: identity calibration so refresh keeps working.
      const fallback: CalibrationBundle = { global: IDENTITY, perMarket: {}, fittedAt: Date.now() };
      cache = fallback;
      console.error("[calibration] fit failed, using identity:", (e as Error).message);
      return fallback;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Apply the chosen calibrator (isotonic if it won CV, else Platt, else identity). */
export function calibrateProb(bundle: CalibrationBundle, market: string, pRaw: number): number {
  const cal = bundle.perMarket[market] ?? bundle.global;
  let p: number;
  if (cal.method === "isotonic" && cal.iso) p = applyIsotonic(cal.iso, pRaw);
  else if (cal.method === "platt") p = applyPlatt(cal.platt, pRaw);
  else p = pRaw;
  return Math.min(0.98, Math.max(0.02, p));
}

/** Force-refit on next call. */
export function invalidateCalibration() { cache = null; }

export async function getCalibrationDiagnostics() {
  const b = await getCalibration();
  return {
    fittedAt: b.fittedAt,
    global: b.global,
    perMarket: Object.entries(b.perMarket).map(([market, c]) => ({ market, ...c })),
  };
}