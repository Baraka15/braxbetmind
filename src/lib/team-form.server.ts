/**
 * Clean-room team-form feature layer.
 *
 * Reads finished matches from `match_results` and derives per-team:
 *   - rolling points-per-game over last N
 *   - goals-for / goals-against per game
 *   - rest days since last fixture
 *   - head-to-head goal differential
 *
 * Maps those features to a small 1X2 probability nudge via a logistic model
 * with hand-set coefficients (not copied from any external repo). The nudge
 * is intentionally small — sharp market consensus stays dominant; form is a
 * tiebreaker, not a contrarian signal.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LAST_N = 6;
const CACHE_TTL_MS = 5 * 60_000;

type Row = {
  home_team: string;
  away_team: string;
  home_goals: number;
  away_goals: number;
  played_at: string;
};

interface TeamFeatures {
  ppg: number;        // points per game over last N
  gfpg: number;       // goals-for per game
  gapg: number;       // goals-against per game
  restDays: number;   // days since last fixture
  games: number;      // sample size
}

const NEUTRAL: TeamFeatures = { ppg: 1.3, gfpg: 1.3, gapg: 1.3, restDays: 7, games: 0 };

let cache: { at: number; sport: string; rows: Row[] } | null = null;

async function loadRows(sportKey: string): Promise<Row[]> {
  if (cache && cache.sport === sportKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.rows;
  }
  const { data, error } = await supabaseAdmin
    .from("match_results")
    .select("home_team, away_team, home_goals, away_goals, played_at")
    .eq("sport_key", sportKey)
    .order("played_at", { ascending: false })
    .limit(800);
  if (error) {
    console.warn("team-form loadRows:", error.message);
    return [];
  }
  const rows = (data ?? []) as Row[];
  cache = { at: Date.now(), sport: sportKey, rows };
  return rows;
}

function featuresFor(team: string, rows: Row[], beforeIso: string): TeamFeatures {
  const before = new Date(beforeIso).getTime();
  const recent: Row[] = [];
  for (const r of rows) {
    const t = new Date(r.played_at).getTime();
    if (t >= before) continue;
    if (r.home_team === team || r.away_team === team) recent.push(r);
    if (recent.length >= LAST_N) break;
  }
  if (!recent.length) return NEUTRAL;

  let pts = 0, gf = 0, ga = 0;
  for (const r of recent) {
    const isHome = r.home_team === team;
    const myG = isHome ? r.home_goals : r.away_goals;
    const oppG = isHome ? r.away_goals : r.home_goals;
    gf += myG; ga += oppG;
    if (myG > oppG) pts += 3; else if (myG === oppG) pts += 1;
  }
  const lastPlayed = new Date(recent[0].played_at).getTime();
  const restDays = Math.max(0, (before - lastPlayed) / 86_400_000);
  return {
    ppg: pts / recent.length,
    gfpg: gf / recent.length,
    gapg: ga / recent.length,
    restDays: Math.min(restDays, 21),
    games: recent.length,
  };
}

function h2hDiff(home: string, away: string, rows: Row[], beforeIso: string): number {
  const before = new Date(beforeIso).getTime();
  let diff = 0, n = 0;
  for (const r of rows) {
    if (new Date(r.played_at).getTime() >= before) continue;
    const sameMatchup =
      (r.home_team === home && r.away_team === away) ||
      (r.home_team === away && r.away_team === home);
    if (!sameMatchup) continue;
    const homeFromHomeTeam = r.home_team === home;
    const d = homeFromHomeTeam ? r.home_goals - r.away_goals : r.away_goals - r.home_goals;
    diff += d; n++;
    if (n >= 6) break;
  }
  return n ? diff / n : 0;
}

/** Softmax over (homeScore, drawScore, awayScore) → 1X2 probabilities. */
function softmax3(h: number, d: number, a: number) {
  const max = Math.max(h, d, a);
  const eh = Math.exp(h - max), ed = Math.exp(d - max), ea = Math.exp(a - max);
  const z = eh + ed + ea;
  return { home: eh / z, draw: ed / z, away: ea / z };
}

/**
 * Returns a 1X2 probability vector from rolling form features alone.
 * If sample size is too small on either team, returns null (caller falls back).
 */
export async function formProbabilities(
  sportKey: string,
  home: string,
  away: string,
  kickoffIso: string,
): Promise<{ home: number; draw: number; away: number } | null> {
  const rows = await loadRows(sportKey);
  if (rows.length < 20) return null;

  const fh = featuresFor(home, rows, kickoffIso);
  const fa = featuresFor(away, rows, kickoffIso);
  if (fh.games < 3 || fa.games < 3) return null;

  const h2h = h2hDiff(home, away, rows, kickoffIso);

  // Strength scores → softmax. Coefficients are hand-tuned, conservative.
  // Home advantage baseline ~0.30 in score-space.
  const strengthH =
    0.55 * fh.ppg + 0.30 * (fh.gfpg - fh.gapg) + 0.02 * fh.restDays + 0.08 * h2h + 0.30;
  const strengthA =
    0.55 * fa.ppg + 0.30 * (fa.gfpg - fa.gapg) + 0.02 * fa.restDays - 0.08 * h2h;
  // Draw score peaks when strengths are close and goals are low.
  const close = -Math.abs(strengthH - strengthA);
  const lowGoals = -(fh.gfpg + fa.gfpg) * 0.15;
  const strengthD = 0.45 + 0.6 * close + lowGoals;

  return softmax3(strengthH, strengthD, strengthA);
}