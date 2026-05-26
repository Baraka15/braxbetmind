/**
 * Walk-forward backtesting against real historical results in `match_results`.
 *
 * For each finished match (sorted by date) we:
 *   1. Fit a Dixon-Coles model on every prior match in the same league.
 *   2. Derive 1X2, Over/Under 2.5 and BTTS probabilities.
 *   3. Pick the model's preferred side, compare to the actual result.
 *   4. Track hit count, Brier score, and a fair-odds ROI estimate.
 *
 * We don't have historical closing odds so ROI is *estimated* assuming the
 * market priced the bet at fair value plus a 5% bookmaker margin (i.e. you
 * obtained odds = (1/p_model) * 0.95). This is a conservative proxy.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { scoreMatrix } from "./dixon-coles.server";
import { deriveMarkets, type MarketKey } from "./markets.server";

const MARGIN = 0.05;

type Result = {
  home_team: string;
  away_team: string;
  home_goals: number;
  away_goals: number;
  played_at: string;
  sport_key: string;
};

type Bucket = { picks: number; hits: number; brier: number; pnlUnits: number; stakedUnits: number };
const newBucket = (): Bucket => ({ picks: 0, hits: 0, brier: 0, pnlUnits: 0, stakedUnits: 0 });

function tier(p: number): "S" | "A" | "B" | "C" {
  if (p >= 0.65) return "S";
  if (p >= 0.55) return "A";
  if (p >= 0.45) return "B";
  return "C";
}

/** Pure DC fit from an array of results. */
function fitFromResults(results: Result[]) {
  const hG: Record<string, number> = {}, hM: Record<string, number> = {};
  const aG: Record<string, number> = {}, aM: Record<string, number> = {};
  const hC: Record<string, number> = {}, aC: Record<string, number> = {};
  let totH = 0, totA = 0, n = 0;
  for (const r of results) {
    hG[r.home_team] = (hG[r.home_team] ?? 0) + r.home_goals;
    hM[r.home_team] = (hM[r.home_team] ?? 0) + 1;
    hC[r.home_team] = (hC[r.home_team] ?? 0) + r.away_goals;
    aG[r.away_team] = (aG[r.away_team] ?? 0) + r.away_goals;
    aM[r.away_team] = (aM[r.away_team] ?? 0) + 1;
    aC[r.away_team] = (aC[r.away_team] ?? 0) + r.home_goals;
    totH += r.home_goals; totA += r.away_goals; n++;
  }
  const lh = n ? totH / n : 1.45;
  const la = n ? totA / n : 1.15;
  const homeAdv = la > 0 ? lh / la : 1.26;
  const teams = new Map<string, { attack: number; defence: number }>();
  for (const t of new Set([...Object.keys(hM), ...Object.keys(aM)])) {
    const m1 = hM[t] ?? 0, m2 = aM[t] ?? 0;
    const ah = m1 ? (hG[t] / m1) / Math.max(lh, 0.01) : 1;
    const aa = m2 ? (aG[t] / m2) / Math.max(la, 0.01) : 1;
    const dh = m1 ? (hC[t] / m1) / Math.max(la, 0.01) : 1;
    const da = m2 ? (aC[t] / m2) / Math.max(lh, 0.01) : 1;
    teams.set(t, { attack: (ah + aa) / 2, defence: (dh + da) / 2 });
  }
  return { teams, homeAdv, leagueAvgGoals: lh + la };
}

function lambdas(model: ReturnType<typeof fitFromResults>, home: string, away: string) {
  const h = model.teams.get(home) ?? { attack: 1, defence: 1 };
  const a = model.teams.get(away) ?? { attack: 1, defence: 1 };
  const base = model.leagueAvgGoals / 2;
  return {
    lh: Math.max(0.15, base * h.attack * a.defence * Math.sqrt(model.homeAdv)),
    la: Math.max(0.15, base * a.attack * h.defence / Math.sqrt(model.homeAdv)),
  };
}

export interface BacktestRow {
  market: MarketKey;
  tier: "S" | "A" | "B" | "C";
  picks: number;
  hits: number;
  hitRate: number;
  brier: number;
  roiPct: number;
  avgProb: number;
}

export async function runBacktest(args: { leagues?: string[]; minSampleForPick?: number }) {
  const { leagues, minSampleForPick = 20 } = args;

  // Load all results, filtered by leagues if provided.
  let q = supabaseAdmin.from("match_results")
    .select("home_team, away_team, home_goals, away_goals, played_at, sport_key")
    .order("played_at", { ascending: true })
    .limit(5000);
  if (leagues?.length) q = q.in("sport_key", leagues);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const all = (data ?? []) as Result[];

  // Bucket key = `${market}::${tier}`
  const buckets = new Map<string, Bucket>();
  const totalsByMarket = new Map<MarketKey, Bucket>();
  let probSum = 0, probN = 0;

  // Per-league walk-forward
  const byLeague = new Map<string, Result[]>();
  for (const r of all) {
    if (!byLeague.has(r.sport_key)) byLeague.set(r.sport_key, []);
    byLeague.get(r.sport_key)!.push(r);
  }

  const markets: MarketKey[] = ["h2h", "ou_2_5", "btts"];

  for (const [, results] of byLeague) {
    const history: Result[] = [];
    for (const match of results) {
      if (history.length >= minSampleForPick) {
        const model = fitFromResults(history);
        const { lh, la } = lambdas(model, match.home_team, match.away_team);
        const sm = scoreMatrix(lh, la);
        const derived = deriveMarkets(sm);

        for (const mkt of markets) {
          const m = derived.find((d) => d.market === mkt)!;
          // Pick the highest-prob selection in this market.
          const entries = Object.entries(m.selections);
          entries.sort((a, b) => b[1] - a[1]);
          const [pickSel, pickProb] = entries[0];

          const hit = didPickWin(mkt, pickSel, match);
          const t = tier(pickProb);
          const key = `${mkt}::${t}`;
          if (!buckets.has(key)) buckets.set(key, newBucket());
          if (!totalsByMarket.has(mkt)) totalsByMarket.set(mkt, newBucket());
          const b = buckets.get(key)!;
          const bt = totalsByMarket.get(mkt)!;

          b.picks++; bt.picks++;
          if (hit) { b.hits++; bt.hits++; }
          b.brier += (hit ? 1 : 0 - pickProb) ** 2;
          bt.brier += (hit ? 1 : 0 - pickProb) ** 2;

          // Fair-odds-with-margin ROI estimate
          const odds = (1 / pickProb) * (1 - MARGIN);
          const pnl = hit ? odds - 1 : -1;
          b.pnlUnits += pnl; b.stakedUnits += 1;
          bt.pnlUnits += pnl; bt.stakedUnits += 1;

          probSum += pickProb; probN++;
        }
      }
      history.push(match);
    }
  }

  const rows: BacktestRow[] = [];
  for (const [key, b] of buckets) {
    const [mkt, t] = key.split("::") as [MarketKey, "S" | "A" | "B" | "C"];
    rows.push({
      market: mkt, tier: t,
      picks: b.picks, hits: b.hits,
      hitRate: b.picks ? b.hits / b.picks : 0,
      brier: b.picks ? b.brier / b.picks : 0,
      roiPct: b.stakedUnits ? (b.pnlUnits / b.stakedUnits) * 100 : 0,
      avgProb: probN ? probSum / probN : 0,
    });
  }
  rows.sort((a, b) => (a.market + a.tier).localeCompare(b.market + b.tier));

  const totals: BacktestRow[] = [];
  for (const [mkt, b] of totalsByMarket) {
    totals.push({
      market: mkt, tier: "S", // unused for totals
      picks: b.picks, hits: b.hits,
      hitRate: b.picks ? b.hits / b.picks : 0,
      brier: b.picks ? b.brier / b.picks : 0,
      roiPct: b.stakedUnits ? (b.pnlUnits / b.stakedUnits) * 100 : 0,
      avgProb: 0,
    });
  }

  return {
    totalMatches: all.length,
    leagues: [...byLeague.keys()],
    rows,
    totals,
    marginAssumed: MARGIN,
  };
}

function didPickWin(market: MarketKey, sel: string, m: Result): boolean {
  const total = m.home_goals + m.away_goals;
  if (market === "h2h") {
    if (sel === "home") return m.home_goals > m.away_goals;
    if (sel === "away") return m.away_goals > m.home_goals;
    if (sel === "draw") return m.home_goals === m.away_goals;
  }
  if (market === "ou_2_5") return sel === "over" ? total > 2 : total <= 2;
  if (market === "btts") {
    const both = m.home_goals > 0 && m.away_goals > 0;
    return sel === "yes" ? both : !both;
  }
  return false;
}