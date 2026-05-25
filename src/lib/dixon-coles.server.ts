/**
 * Dixon-Coles goal-expectancy model.
 * Fits attack/defence strengths from recent league results.
 * Returns a score matrix used to derive every market.
 */
import { loadResultsFromDb } from "./football-data.server";

const MAX_GOALS = 8;

interface TeamStrength {
  attack: number;
  defence: number;
}

export interface DCModel {
  teams: Map<string, TeamStrength>;
  homeAdv: number;
  leagueAvgGoals: number;
}

const dcCache = new Map<string, { at: number; model: DCModel }>();
const DC_TTL = 30 * 60 * 1000;

/** Fit a simple attack/defence-strength model from recent results. */
export async function fitDixonColes(sportKey: string): Promise<DCModel> {
  const cached = dcCache.get(sportKey);
  if (cached && Date.now() - cached.at < DC_TTL) return cached.model;

  const results = await loadResultsFromDb(sportKey, 300);
  const homeGoalsSum: Record<string, number> = {};
  const homeMatches: Record<string, number> = {};
  const awayGoalsSum: Record<string, number> = {};
  const awayMatches: Record<string, number> = {};
  const homeConcededSum: Record<string, number> = {};
  const awayConcededSum: Record<string, number> = {};

  let totalHomeGoals = 0;
  let totalAwayGoals = 0;
  let totalMatches = 0;

  for (const r of results) {
    homeGoalsSum[r.home_team] = (homeGoalsSum[r.home_team] ?? 0) + r.home_goals;
    homeMatches[r.home_team] = (homeMatches[r.home_team] ?? 0) + 1;
    homeConcededSum[r.home_team] = (homeConcededSum[r.home_team] ?? 0) + r.away_goals;

    awayGoalsSum[r.away_team] = (awayGoalsSum[r.away_team] ?? 0) + r.away_goals;
    awayMatches[r.away_team] = (awayMatches[r.away_team] ?? 0) + 1;
    awayConcededSum[r.away_team] = (awayConcededSum[r.away_team] ?? 0) + r.home_goals;

    totalHomeGoals += r.home_goals;
    totalAwayGoals += r.away_goals;
    totalMatches++;
  }

  const leagueHomeAvg = totalMatches ? totalHomeGoals / totalMatches : 1.45;
  const leagueAwayAvg = totalMatches ? totalAwayGoals / totalMatches : 1.15;
  const leagueAvgGoals = leagueHomeAvg + leagueAwayAvg;
  const homeAdv = leagueAwayAvg > 0 ? leagueHomeAvg / leagueAwayAvg : 1.26;

  const teams = new Map<string, TeamStrength>();
  const teamSet = new Set([
    ...Object.keys(homeMatches),
    ...Object.keys(awayMatches),
  ]);
  for (const t of teamSet) {
    const hm = homeMatches[t] ?? 0;
    const am = awayMatches[t] ?? 0;
    const attackHome = hm ? (homeGoalsSum[t] / hm) / Math.max(leagueHomeAvg, 0.01) : 1;
    const attackAway = am ? (awayGoalsSum[t] / am) / Math.max(leagueAwayAvg, 0.01) : 1;
    const defenceHome = hm ? (homeConcededSum[t] / hm) / Math.max(leagueAwayAvg, 0.01) : 1;
    const defenceAway = am ? (awayConcededSum[t] / am) / Math.max(leagueHomeAvg, 0.01) : 1;
    teams.set(t, {
      attack: (attackHome + attackAway) / 2,
      defence: (defenceHome + defenceAway) / 2,
    });
  }

  const model: DCModel = { teams, homeAdv, leagueAvgGoals };
  dcCache.set(sportKey, { at: Date.now(), model });
  return model;
}

function poissonPMF(lambda: number, k: number): number {
  let logp = -lambda + k * Math.log(Math.max(lambda, 1e-9));
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

/** Dixon-Coles low-score adjustment (tau function). */
function tau(h: number, a: number, lh: number, la: number, rho = -0.08): number {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

export interface ScoreMatrix {
  matrix: number[][]; // matrix[h][a] = probability
  lambdaHome: number;
  lambdaAway: number;
}

/** Produce a goal-score probability matrix for home/away expected goals. */
export function scoreMatrix(lambdaHome: number, lambdaAway: number): ScoreMatrix {
  const matrix: number[][] = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    matrix[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poissonPMF(lambdaHome, h) * poissonPMF(lambdaAway, a) * tau(h, a, lambdaHome, lambdaAway);
      matrix[h][a] = p;
      total += p;
    }
  }
  // Normalise
  if (total > 0) {
    for (let h = 0; h <= MAX_GOALS; h++)
      for (let a = 0; a <= MAX_GOALS; a++) matrix[h][a] /= total;
  }
  return { matrix, lambdaHome, lambdaAway };
}

/** Expected lambdas for home vs away given the DC model. */
export function expectedLambdas(model: DCModel, home: string, away: string): { lh: number; la: number } {
  const h = model.teams.get(home) ?? { attack: 1, defence: 1 };
  const a = model.teams.get(away) ?? { attack: 1, defence: 1 };
  const baseHome = model.leagueAvgGoals / 2;
  const baseAway = model.leagueAvgGoals / 2;
  const lh = baseHome * h.attack * a.defence * Math.sqrt(model.homeAdv);
  const la = baseAway * a.attack * h.defence / Math.sqrt(model.homeAdv);
  return { lh: Math.max(0.15, lh), la: Math.max(0.15, la) };
}