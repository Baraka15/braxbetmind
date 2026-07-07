/**
 * Probability sharpening (γ transform).
 *
 *   p' = p^γ / (p^γ + (1-p)^γ)
 *
 * With γ < 1 this pulls probabilities toward 0.5, killing overconfidence.
 * With γ > 1 it does the opposite. We use γ ≈ 0.9 across the board: the
 * ensemble tends to be slightly overconfident in one direction on thin
 * markets, and pulling toward 0.5 costs us a few false positives but
 * meaningfully cuts loss rate on borderline picks.
 *
 * If the underlying calibration already had 2000+ samples, we shrink γ back
 * toward 1 (no-op) — the calibrator is doing its job and we don't need to
 * flatten further.
 */

export const DEFAULT_GAMMA = 0.9;

export function sharpen(p: number, gamma = DEFAULT_GAMMA): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return p;
  if (gamma === 1) return p;
  const a = Math.pow(p, gamma);
  const b = Math.pow(1 - p, gamma);
  return a / (a + b);
}

/** Adaptive γ: fully sharpen when calibrator has < 100 samples, no sharpen at 2000+. */
export function adaptiveGamma(calibratorN: number): number {
  if (calibratorN >= 2000) return 1;
  if (calibratorN <= 100) return DEFAULT_GAMMA;
  const t = (calibratorN - 100) / (2000 - 100);
  return DEFAULT_GAMMA + t * (1 - DEFAULT_GAMMA);
}