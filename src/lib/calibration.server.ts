/**
 * Rolling-window probability calibration (Platt scaling).
 *
 * Pulls the last N settled bets, fits a per-market logistic recalibration
 *   p_cal = sigmoid(a * logit(p_raw) + b)
 * via Newton-Raphson on the binomial log-likelihood, then shrinks toward
 * the identity (a=1, b=0) based on sample size so thin markets don't
 * over-fit.
 *
 * Cached in-memory for CALIBRATION_TTL_MS so we don't refit on every event
 * inside a single refresh sweep, but recompute as new settlements land.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const WINDOW_DAYS = 60;
const MAX_SAMPLES = 1500;
const MIN_SAMPLES_PER_MARKET = 25;   // below this, blend toward global model
const FULL_TRUST_SAMPLES = 150;      // at/above this, use market-specific fit fully
const CALIBRATION_TTL_MS = 60_000;   // refit at most once a minute
const EPS = 1e-6;

export interface Calibrator {
  a: number;          // slope on logit
  b: number;          // intercept
  n: number;          // samples used
  brierRaw: number;   // pre-calibration Brier (diagnostic)
  brierCal: number;   // post-calibration Brier (diagnostic)
}

interface CalibrationBundle {
  global: Calibrator;
  perMarket: Record<string, Calibrator>;
  fittedAt: number;
}

let cache: CalibrationBundle | null = null;
let inflight: Promise<CalibrationBundle> | null = null;

const IDENTITY: Calibrator = { a: 1, b: 0, n: 0, brierRaw: 0, brierCal: 0 };

function logit(p: number) {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
}
function sigmoid(x: number) {
  if (x >= 0) { const e = Math.exp(-x); return 1 / (1 + e); }
  const e = Math.exp(x); return e / (1 + e);
}

/** Fit Platt {a,b} via 25-iter Newton-Raphson. Returns identity on degenerate input. */
function fitPlatt(samples: { p: number; y: number }[]): Calibrator {
  const n = samples.length;
  if (n < 8) return { ...IDENTITY, n };

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
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return { ...IDENTITY, n };
  a = Math.min(3, Math.max(0.2, a));
  b = Math.min(2, Math.max(-2, b));

  let brierRaw = 0, brierCal = 0;
  for (let i = 0; i < n; i++) {
    const pCal = sigmoid(a * xs[i] + b);
    brierRaw += (samples[i].p - ys[i]) ** 2;
    brierCal += (pCal - ys[i]) ** 2;
  }
  return { a, b, n, brierRaw: brierRaw / n, brierCal: brierCal / n };
}

/** Shrink fitted calibrator toward identity based on sample count. */
function shrink(fit: Calibrator): Calibrator {
  if (fit.n >= FULL_TRUST_SAMPLES) return fit;
  const t = Math.max(0, fit.n) / FULL_TRUST_SAMPLES;
  return {
    a: 1 + t * (fit.a - 1),
    b: t * fit.b,
    n: fit.n,
    brierRaw: fit.brierRaw,
    brierCal: fit.brierCal,
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

  const global = shrink(fitPlatt(all));
  const perMarket: Record<string, Calibrator> = {};
  for (const [mkt, samples] of byMarket.entries()) {
    if (samples.length < MIN_SAMPLES_PER_MARKET) {
      perMarket[mkt] = global;
    } else {
      perMarket[mkt] = shrink(fitPlatt(samples));
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

/** Apply Platt calibration for a market to a raw probability. */
export function calibrateProb(bundle: CalibrationBundle, market: string, pRaw: number): number {
  const cal = bundle.perMarket[market] ?? bundle.global;
  const p = sigmoid(cal.a * logit(pRaw) + cal.b);
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