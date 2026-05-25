/**
 * Value-bet math: overround removal, edge %, Kelly stake, sharp-move detection.
 */

/** Remove the bookmaker's overround using the proportional (multiplicative) method.
 *  Returns fair probabilities that sum to 1. */
export function fairProbabilities(home: number, draw: number, away: number): { home: number; draw: number; away: number } {
  const ih = 1 / home;
  const id = 1 / draw;
  const ia = 1 / away;
  const sum = ih + id + ia;
  return { home: ih / sum, draw: id / sum, away: ia / sum };
}

/** Edge = AI_Prob - Implied_Prob (using best available odds, NOT overround-adjusted, since edge is vs the price you can take). */
export function edgeForOutcome(aiProb: number, bestOdds: number): { edgePct: number; impliedProb: number } {
  const impliedProb = 1 / bestOdds;
  const edgePct = aiProb - impliedProb;
  return { edgePct, impliedProb };
}

/** Fractional Kelly stake as a fraction of bankroll. Capped at maxStakePct. */
export function kellyStakePct(aiProb: number, bestOdds: number, fraction: number, maxStakePct: number): number {
  const b = bestOdds - 1;
  if (b <= 0) return 0;
  const q = 1 - aiProb;
  const raw = (b * aiProb - q) / b; // full Kelly
  if (raw <= 0) return 0;
  return Math.min(raw * fraction, maxStakePct);
}

/** Sharp-money signal: closing-vs-opening odds movement on the sharp books.
 *  Returns true if any outcome moved >= 5%. */
export function isSharpMove(
  current: { home?: number; draw?: number; away?: number },
  opening: { home?: number; draw?: number; away?: number },
  threshold = 0.05,
): boolean {
  for (const k of ["home", "draw", "away"] as const) {
    const c = current[k];
    const o = opening[k];
    if (!c || !o) continue;
    const move = Math.abs(c - o) / o;
    if (move >= threshold) return true;
  }
  return false;
}
