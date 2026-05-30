/**
 * In-play (live) Bayesian model.
 *
 * Given a pre-match Dixon-Coles fit (expected goals lh / la), the current
 * score and elapsed minutes, we update the matrix as:
 *
 *   final_score = current_score + remaining_score
 *
 * where the remaining-score distribution is a fresh score-matrix built with
 * lambdas scaled by (90 - elapsed) / 90. We then convolve with the current
 * score so every market (1X2, O/U lines, BTTS, exact scores) can be priced
 * from the same posterior matrix.
 *
 * This is intentionally lightweight (no Monte Carlo) so it can run in a
 * Worker on every 30s refresh without burning the Odds API quota.
 */
import { scoreMatrix, type ScoreMatrix } from "./dixon-coles.server";
import { deriveMarkets } from "./markets.server";

const REGULATION_MINUTES = 90;
const RED_CARD_PENALTY = 0.7; // multiplier on the offending team's remaining lambda

export interface LiveSnapshot {
  minutesElapsed: number;
  homeGoals: number;
  awayGoals: number;
  homeRedCards?: number;
  awayRedCards?: number;
}

/** Posterior score matrix over the FINAL full-time score. */
export function liveScoreMatrix(prior: { lh: number; la: number }, snap: LiveSnapshot): ScoreMatrix {
  const remainingFrac = Math.max(0, (REGULATION_MINUTES - Math.min(snap.minutesElapsed, REGULATION_MINUTES)) / REGULATION_MINUTES);
  const redH = Math.pow(RED_CARD_PENALTY, snap.homeRedCards ?? 0);
  const redA = Math.pow(RED_CARD_PENALTY, snap.awayRedCards ?? 0);
  const lhRem = prior.lh * remainingFrac * redH;
  const laRem = prior.la * remainingFrac * redA;
  const rem = scoreMatrix(Math.max(0.001, lhRem), Math.max(0.001, laRem));

  const N = rem.matrix.length;
  const finalSize = N + Math.max(snap.homeGoals, snap.awayGoals);
  const out: number[][] = Array.from({ length: finalSize }, () => Array(finalSize).fill(0));
  for (let h = 0; h < N; h++) {
    for (let a = 0; a < N; a++) {
      const fh = h + snap.homeGoals;
      const fa = a + snap.awayGoals;
      if (fh < finalSize && fa < finalSize) out[fh][fa] += rem.matrix[h][a];
    }
  }
  return { matrix: out, lambdaHome: lhRem + snap.homeGoals, lambdaAway: laRem + snap.awayGoals };
}

/** Top-N most likely correct scores given a posterior matrix. */
export function topCorrectScores(sm: ScoreMatrix, n = 5): Array<{ home: number; away: number; prob: number }> {
  const out: Array<{ home: number; away: number; prob: number }> = [];
  for (let h = 0; h < sm.matrix.length; h++) {
    for (let a = 0; a < sm.matrix.length; a++) out.push({ home: h, away: a, prob: sm.matrix[h][a] });
  }
  out.sort((x, y) => y.prob - x.prob);
  return out.slice(0, n);
}

/** Derive every market (1X2, O/U, BTTS, DC, DNB) from a live posterior matrix. */
export function liveMarkets(sm: ScoreMatrix) {
  return deriveMarkets(sm);
}
