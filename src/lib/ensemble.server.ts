/**
 * 7-layer ensemble: combines every model into a single per-selection probability,
 * then optionally lets the AI reasoning layer adjust + tier.
 *
 * Layers:
 *   L1 Poisson (market-seeded)
 *   L2 Dixon-Coles (real fitted from results)
 *   L3 Elo (real, from results)
 *   L4 Sharp-book consensus (overround-removed average)
 *   L5 Sharp-vs-soft divergence (public-fade signal)
 *   L6 Line-movement signal (opening vs current)
 *   L7 AI reasoning (Gemini, tier + rationale + small adjustment)
 */
import { fairProbabilities } from "./value-engine.server";
import { expectedLambdas, fitDixonColes, scoreMatrix } from "./dixon-coles.server";
import { eloExpected, eloTo1x2, getEloMap } from "./elo.server";
import { deriveMarkets, type MarketKey } from "./markets.server";
import type { OddsApiEvent } from "./odds-api.server";

const WEIGHTS = {
  // Sharp market consensus dominates — it's the single most accurate prior we
  // have. Stats models are nudges, not opinions.
  poisson: 0.06,
  dc: 0.14,
  elo: 0.08,
  consensus: 0.55,
  divergence: 0.12,
  movement: 0.05,
  // L7 (AI) acts AFTER blend via small adjustedProb override; its implicit weight is the cap.
};

/** Minimum number of bookmakers that must price an H2H market before we trust it. */
const MIN_H2H_BOOKS = 4;
/** Minimum number of SHARP books (Pinnacle / Betfair / 1xBet) required. */
const MIN_SHARP_BOOKS = 1;
/** Maximum tolerable disagreement between model and sharp consensus.
 *  If |finalProb - sharpFair| > this, the market is regime-unstable; skip. */
const MAX_MODEL_MARKET_DRIFT = 0.18;

export interface BookOdds {
  bookmaker: string;
  sharp: boolean;
  home?: number;
  draw?: number;
  away?: number;
  totals?: { point: number; over: number; under: number }[];
  btts?: { yes: number; no: number };
}

export interface EnsembleSelection {
  market: MarketKey;
  selection: string;
  bestOdds: number;
  bookmaker: string;
  layers: {
    poisson: number;
    dixonColes: number;
    elo: number;
    marketConsensus: number;
    sharpVsSoftDelta: number;
    lineMovement: number;
  };
  finalProb: number;
}

/** Build the ensemble for one event across every market we can price. */
export async function runEnsemble(args: {
  event: OddsApiEvent;
  books: BookOdds[];
  openingPinn?: { home?: number; draw?: number; away?: number };
  currentPinn?: { home?: number; draw?: number; away?: number };
}): Promise<EnsembleSelection[]> {
  const { event, books, openingPinn, currentPinn } = args;

  // === Compute per-market best odds across all books ===
  const bestH2H = bestOf(books.map((b) => ({ home: b.home, draw: b.draw, away: b.away, book: b.bookmaker })));
  const bestBtts = bestSimple(books.map((b) => ({ yes: b.btts?.yes, no: b.btts?.no, book: b.bookmaker })), ["yes", "no"]);
  const bestTotals: Record<string, { over?: { price: number; book: string }; under?: { price: number; book: string } }> = {};
  for (const b of books) {
    for (const t of b.totals ?? []) {
      const key = String(t.point);
      const slot = bestTotals[key] ?? {};
      if (!slot.over || t.over > slot.over.price) slot.over = { price: t.over, book: b.bookmaker };
      if (!slot.under || t.under > slot.under.price) slot.under = { price: t.under, book: b.bookmaker };
      bestTotals[key] = slot;
    }
  }

  // === Sharp consensus probabilities for 1X2 ===
  const sharps = books.filter((b) => b.sharp && b.home && b.draw && b.away);
  const softs = books.filter((b) => !b.sharp && b.home && b.draw && b.away);
  const sharpFair = avgFair(sharps);
  const softFair = avgFair(softs);

  // Liquidity / sharpness gate: thin markets are noise.
  const h2hBooks = books.filter((b) => b.home && b.draw && b.away).length;
  if (h2hBooks < MIN_H2H_BOOKS || sharps.length < MIN_SHARP_BOOKS || !sharpFair) {
    return [];
  }

  // === Dixon-Coles + Elo ===
  const dc = await fitDixonColes(event.sport_key);
  const { lh, la } = expectedLambdas(dc, event.home_team, event.away_team);
  const sm = scoreMatrix(lh, la);
  const dcMarkets = deriveMarkets(sm);

  const eloMap = await getEloMap(event.sport_key);
  const eloH = eloMap.get(event.home_team) ?? 1500;
  const eloA = eloMap.get(event.away_team) ?? 1500;
  const eloHomeWin = eloExpected(eloH, eloA);
  const elo1x2 = eloTo1x2(eloHomeWin);

  // Elo + DC also produce derived markets (over/under, BTTS from same matrix)
  const eloMatrix = elo1x2; // only h2h available directly from Elo

  // === Layer 1: Poisson (market-seeded) ===
  const poissonFair = sharpFair ?? softFair;

  // === Line movement signal (toward home) ===
  function moveFor(out: "home" | "draw" | "away"): number {
    const o = openingPinn?.[out];
    const c = currentPinn?.[out];
    if (!o || !c) return 0;
    return (o - c) / o; // odds dropping = money coming in for this outcome
  }

  // === Sharp-vs-soft delta (toward home) ===
  function deltaFor(out: "home" | "draw" | "away"): number {
    if (!sharpFair || !softFair) return 0;
    return sharpFair[out] - softFair[out]; // sharps think it's more likely than soft books
  }

  const selections: EnsembleSelection[] = [];

  // ===== 1X2 =====
  if (poissonFair) {
    for (const k of ["home", "draw", "away"] as const) {
      const best = bestH2H[k];
      if (!best) continue;
      const layers = {
        poisson: poissonFair[k],
        dixonColes: dcMarkets[0].selections[k],
        elo: eloMatrix[k],
        marketConsensus: (sharpFair?.[k] ?? poissonFair[k]),
        sharpVsSoftDelta: deltaFor(k),
        lineMovement: moveFor(k),
      };
      const finalProb = blend(layers);
      selections.push({
        market: "h2h",
        selection: k,
        bestOdds: best.price,
        bookmaker: best.book,
        layers,
        finalProb,
      });
    }
  }

  // ===== Over/Under (use real market price when book offers that line) =====
  const ouLineToMarket: Record<string, MarketKey> = { "1.5": "ou_1_5", "2.5": "ou_2_5", "3.5": "ou_3_5" };
  for (const [line, mkt] of Object.entries(ouLineToMarket)) {
    const dcM = dcMarkets.find((m) => m.market === mkt)!;
    const slot = bestTotals[line];
    if (!slot) continue;
    for (const side of ["over", "under"] as const) {
      const best = slot[side];
      if (!best) continue;
      const dcProb = dcM.selections[side];
      // Consensus = DC + (market implied, only if we trust it). Treat real market as another vote.
      const impl = 1 / best.price;
      const layers = {
        poisson: dcProb,
        dixonColes: dcProb,
        elo: dcProb, // Elo doesn't price totals; reuse DC
        marketConsensus: impl, // raw market line for this side
        sharpVsSoftDelta: 0,
        lineMovement: 0,
      };
      const finalProb = blend(layers);
      selections.push({ market: mkt, selection: side, bestOdds: best.price, bookmaker: best.book, layers, finalProb });
    }
  }

  // ===== BTTS =====
  const dcBtts = dcMarkets.find((m) => m.market === "btts")!;
  for (const side of ["yes", "no"] as const) {
    const best = bestBtts[side];
    if (!best) continue;
    const dcProb = dcBtts.selections[side];
    const impl = 1 / best.price;
    const layers = {
      poisson: dcProb, dixonColes: dcProb, elo: dcProb,
      marketConsensus: impl, sharpVsSoftDelta: 0, lineMovement: 0,
    };
    selections.push({ market: "btts", selection: side, bestOdds: best.price, bookmaker: best.book, layers, finalProb: blend(layers) });
  }

  // ===== Double Chance + DNB are derived from the same 1X2 odds basket =====
  // INTENTIONALLY DISABLED: synthetic DC / DNB prices from fair 1X2 created
  // phantom edges (no real bookmaker offered them at those prices) and were
  // the main source of losing tickets. Only price markets where a real book
  // has posted a real number.

  // ONE bet per match: pick the single selection with the highest edge across
  // every market. This prevents the same team showing up multiple times under
  // different markets (e.g. Home 1X2 and Home DNB and 1X DC).
  let best: EnsembleSelection | null = null;
  let bestEdge = -Infinity;
  for (const s of selections) {
    const edge = s.finalProb - 1 / s.bestOdds;
    if (edge > bestEdge) { best = s; bestEdge = edge; }
  }
  if (!best) return [];

  // Regime-stability gate: if our final prob is wildly off the sharp market
  // consensus, we don't actually understand this game — refuse to quote it.
  const drift = Math.abs(best.finalProb - best.layers.marketConsensus);
  if (drift > MAX_MODEL_MARKET_DRIFT) return [];

  return [best];
}

function blend(L: EnsembleSelection["layers"]): number {
  const base =
    L.poisson * WEIGHTS.poisson +
    L.dixonColes * WEIGHTS.dc +
    L.elo * WEIGHTS.elo +
    L.marketConsensus * WEIGHTS.consensus;
  // Treat divergence & movement as nudges, scaled by their weight.
  const nudge = L.sharpVsSoftDelta * WEIGHTS.divergence + L.lineMovement * WEIGHTS.movement;
  const totalWeight = WEIGHTS.poisson + WEIGHTS.dc + WEIGHTS.elo + WEIGHTS.consensus;
  const blended = base / totalWeight + nudge;
  return Math.min(0.98, Math.max(0.02, blended));
}

function avgFair(books: BookOdds[]): { home: number; draw: number; away: number } | null {
  if (!books.length) return null;
  let h = 0, d = 0, a = 0, n = 0;
  for (const b of books) {
    if (!b.home || !b.draw || !b.away) continue;
    const f = fairProbabilities(b.home, b.draw, b.away);
    h += f.home; d += f.draw; a += f.away; n++;
  }
  if (!n) return null;
  return { home: h / n, draw: d / n, away: a / n };
}

function bestOf(rows: { home?: number; draw?: number; away?: number; book: string }[]) {
  const out: Record<"home" | "draw" | "away", { price: number; book: string } | undefined> = { home: undefined, draw: undefined, away: undefined };
  for (const r of rows) {
    for (const k of ["home", "draw", "away"] as const) {
      const v = r[k];
      if (!v) continue;
      if (!out[k] || v > out[k]!.price) out[k] = { price: v, book: r.book };
    }
  }
  return out;
}

function bestSimple<T extends string>(rows: ({ book: string } & Partial<Record<T, number>>)[], keys: T[]) {
  const out = {} as Record<T, { price: number; book: string } | undefined>;
  for (const k of keys) out[k] = undefined;
  for (const r of rows) {
    for (const k of keys) {
      const v = r[k];
      if (!v) continue;
      if (!out[k] || v > out[k]!.price) out[k] = { price: v, book: r.book };
    }
  }
  return out;
}