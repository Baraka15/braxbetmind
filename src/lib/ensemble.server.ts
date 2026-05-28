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
  poisson: 0.10,
  dc: 0.18,
  elo: 0.12,
  consensus: 0.32,
  divergence: 0.10,
  movement: 0.06,
  // L7 (AI) acts AFTER blend via small adjustedProb override; its implicit weight is the cap.
};

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
  // We synthesise a virtual best price from the fair 1X2 probabilities.
  if (bestH2H.home && bestH2H.draw && bestH2H.away && poissonFair) {
    const dcDouble = dcMarkets.find((m) => m.market === "dc")!;
    const dnbM = dcMarkets.find((m) => m.market === "dnb")!;
    const fairFor = (k: "home" | "draw" | "away") => poissonFair[k];
    // Apply a small bookmaker margin so we don't overstate edges.
    const MARGIN = 0.05;
    const fairPrice = (p: number) => (1 / Math.max(0.02, p)) * (1 - MARGIN);

    // Double chance: fair odds = 1 / (p_a + p_b), then trimmed by margin.
    const dcPairs: { sel: string; price: number; modelProb: number }[] = [
      { sel: "1X", price: fairPrice(fairFor("home") + fairFor("draw")), modelProb: dcDouble.selections["1X"] },
      { sel: "12", price: fairPrice(fairFor("home") + fairFor("away")), modelProb: dcDouble.selections["12"] },
      { sel: "X2", price: fairPrice(fairFor("draw") + fairFor("away")), modelProb: dcDouble.selections["X2"] },
    ];
    for (const p of dcPairs) {
      const layers = {
        poisson: p.modelProb, dixonColes: p.modelProb, elo: p.modelProb,
        marketConsensus: 1 / p.price, sharpVsSoftDelta: 0, lineMovement: 0,
      };
      selections.push({ market: "dc", selection: p.sel, bestOdds: p.price, bookmaker: "synthetic", layers, finalProb: blend(layers) });
    }

    // DNB: stake refunded on draw. Fair payout = raw_odds * (1 - p_draw).
    // (If you wager 1 and draw probability is p_d, expected stake at risk is
    // (1 - p_d); payout on win is raw_odds, so effective price = raw * (1 - p_d).)
    const fairDraw = fairFor("draw");
    for (const side of ["home", "away"] as const) {
      const raw = bestH2H[side]!.price;
      const effective = Math.max(1.01, raw * (1 - fairDraw));
      const layers = {
        poisson: dnbM.selections[side], dixonColes: dnbM.selections[side], elo: dnbM.selections[side],
        marketConsensus: 1 / effective, sharpVsSoftDelta: 0, lineMovement: 0,
      };
      selections.push({ market: "dnb", selection: side, bestOdds: effective, bookmaker: bestH2H[side]!.book, layers, finalProb: blend(layers) });
    }
  }

  // ONE bet per match: pick the single selection with the highest edge across
  // every market. This prevents the same team showing up multiple times under
  // different markets (e.g. Home 1X2 and Home DNB and 1X DC).
  let best: EnsembleSelection | null = null;
  let bestEdge = -Infinity;
  for (const s of selections) {
    const edge = s.finalProb - 1 / s.bestOdds;
    if (edge > bestEdge) { best = s; bestEdge = edge; }
  }
  return best ? [best] : [];
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