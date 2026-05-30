/**
 * CSV-driven backtest.
 * Expected columns: date, home, away, home_odds, draw_odds, away_odds, home_score, away_score
 *
 * Model: market-seeded Poisson with a deterministic underdog tilt
 *        (same fallback used by predictMatch when no external model is wired).
 * Pick: best EV across 1X2 above min edge.
 * Metrics: hit rate, ROI%, max drawdown%, Sharpe (per-bet), Brier, calibration bins.
 */
import { fairProbabilities } from "./value-engine.server";

export interface CsvBacktestParams {
  csv: string;
  minEdge: number;        // 0..1
  kellyFraction: number;  // 0..1
  startingBankroll: number;
}

export interface CsvBacktestRow {
  date: string;
  home: string;
  away: string;
  pick: "home" | "draw" | "away";
  odds: number;
  modelProb: number;
  edgePct: number;
  stakeUnits: number;
  pnlUnits: number;
  bankroll: number;
  won: boolean;
}

export interface CsvBacktestResult {
  totalRows: number;
  bets: number;
  hits: number;
  hitRate: number;
  roiPct: number;
  finalBankroll: number;
  totalPnlUnits: number;
  maxDrawdownPct: number;
  sharpe: number;
  brier: number;
  equityCurve: Array<{ idx: number; date: string; bankroll: number }>;
  calibration: Array<{ bucket: string; predicted: number; actual: number; n: number }>;
  rows: CsvBacktestRow[];
}

type Row = {
  date: string; home: string; away: string;
  ho: number; do_: number; ao: number; hs: number; as_: number;
};

function parseCsv(text: string): Row[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const head = lines[0].toLowerCase().split(",").map((s) => s.trim());
  const idx = (name: string, alts: string[] = []) => {
    const all = [name, ...alts];
    for (const a of all) {
      const i = head.indexOf(a);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iDate = idx("date");
  const iHome = idx("home", ["home_team", "hometeam"]);
  const iAway = idx("away", ["away_team", "awayteam"]);
  const iHO = idx("home_odds", ["b365h", "psh"]);
  const iDO = idx("draw_odds", ["b365d", "psd"]);
  const iAO = idx("away_odds", ["b365a", "psa"]);
  const iHS = idx("home_score", ["fthg", "home_goals"]);
  const iAS = idx("away_score", ["ftag", "away_goals"]);
  if ([iDate, iHome, iAway, iHO, iDO, iAO, iHS, iAS].some((i) => i < 0)) {
    throw new Error("CSV missing required columns: date, home, away, home_odds, draw_odds, away_odds, home_score, away_score");
  }
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((s) => s.trim());
    const ho = +cells[iHO], do_ = +cells[iDO], ao = +cells[iAO];
    const hs = +cells[iHS], as_ = +cells[iAS];
    if (![ho, do_, ao].every((n) => n > 1.01 && Number.isFinite(n))) continue;
    if (![hs, as_].every((n) => Number.isFinite(n) && n >= 0)) continue;
    out.push({ date: cells[iDate], home: cells[iHome], away: cells[iAway], ho, do_, ao, hs, as_ });
  }
  return out;
}

function modelProbs(ho: number, d: number, ao: number) {
  const fair = fairProbabilities(ho, d, ao);
  const underdogIsAway = fair.home >= fair.away;
  const tilt = 0.08, drawCut = 0.02;
  let pH = underdogIsAway ? fair.home - tilt : fair.home + tilt;
  let pA = underdogIsAway ? fair.away + tilt : fair.away - tilt;
  let pD = Math.max(0.05, fair.draw - drawCut);
  pH = Math.max(0.02, pH); pA = Math.max(0.02, pA);
  const s = pH + pD + pA;
  return { home: pH / s, draw: pD / s, away: pA / s };
}

export function runCsvBacktest(params: CsvBacktestParams): CsvBacktestResult {
  const rows = parseCsv(params.csv);
  const out: CsvBacktestRow[] = [];
  let bankroll = params.startingBankroll;
  let peak = bankroll;
  let maxDD = 0;
  let brierSum = 0;
  const returns: number[] = [];
  // Calibration: 10 buckets on predicted prob, track actual wins.
  const buckets = Array.from({ length: 10 }, () => ({ pSum: 0, win: 0, n: 0 }));

  for (const r of rows) {
    const mp = modelProbs(r.ho, r.do_, r.ao);
    const odds = { home: r.ho, draw: r.do_, away: r.ao } as const;
    const evs = {
      home: mp.home * odds.home - 1,
      draw: mp.draw * odds.draw - 1,
      away: mp.away * odds.away - 1,
    };
    let pick: "home" | "draw" | "away" | null = null;
    let bestEv = -Infinity;
    (Object.keys(evs) as Array<keyof typeof evs>).forEach((k) => {
      if (evs[k] > bestEv) { bestEv = evs[k]; pick = k; }
    });
    if (!pick || bestEv < params.minEdge) continue;

    const p = mp[pick];
    const o = odds[pick];
    const b = o - 1;
    const kelly = Math.max(0, (b * p - (1 - p)) / b) * params.kellyFraction;
    const stake = bankroll * Math.min(0.1, kelly);
    if (stake <= 0) continue;

    const winner: "home" | "draw" | "away" = r.hs > r.as_ ? "home" : r.hs < r.as_ ? "away" : "draw";
    const won = pick === winner;
    const pnl = won ? stake * (o - 1) : -stake;
    bankroll += pnl;
    peak = Math.max(peak, bankroll);
    const dd = peak > 0 ? (peak - bankroll) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    returns.push(pnl / Math.max(1e-9, stake));
    brierSum += ((won ? 1 : 0) - p) ** 2;

    const bIdx = Math.min(9, Math.floor(p * 10));
    buckets[bIdx].pSum += p; buckets[bIdx].n += 1; if (won) buckets[bIdx].win += 1;

    out.push({
      date: r.date, home: r.home, away: r.away,
      pick, odds: o, modelProb: p, edgePct: bestEv,
      stakeUnits: stake, pnlUnits: pnl, bankroll, won,
    });
  }

  const totalStake = out.reduce((s, x) => s + x.stakeUnits, 0);
  const totalPnl = out.reduce((s, x) => s + x.pnlUnits, 0);
  const hits = out.filter((x) => x.won).length;
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(Math.max(1, returns.length)) : 0;

  return {
    totalRows: rows.length,
    bets: out.length,
    hits,
    hitRate: out.length ? hits / out.length : 0,
    roiPct: totalStake > 0 ? (totalPnl / totalStake) * 100 : 0,
    finalBankroll: bankroll,
    totalPnlUnits: totalPnl,
    maxDrawdownPct: maxDD * 100,
    sharpe,
    brier: out.length ? brierSum / out.length : 0,
    equityCurve: [{ idx: 0, date: rows[0]?.date ?? "start", bankroll: params.startingBankroll },
      ...out.map((r, i) => ({ idx: i + 1, date: r.date, bankroll: r.bankroll }))],
    calibration: buckets.map((b, i) => ({
      bucket: `${i * 10}-${i * 10 + 10}%`,
      predicted: b.n ? b.pSum / b.n : 0,
      actual: b.n ? b.win / b.n : 0,
      n: b.n,
    })).filter((b) => b.n > 0),
    rows: out,
  };
}