/**
 * Steam / sharp-vs-soft divergence detector.
 *
 * Given the opening + current H2H prices from Pinnacle (sharp anchor) and
 * the average current price from soft books, flag selections where:
 *   - Pinnacle line has moved toward this side by > SHARP_MOVE_MIN, AND
 *   - Soft-book consensus has NOT moved with it (divergence > MIN_DIVERGENCE).
 *
 * That's the textbook "steam" pattern: sharps are hammering one side while
 * the public still holds the other. Every detection is logged to
 * `steam_signals` so the dashboard can show recent activity and so we can
 * back-test its hit rate honestly.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fairProbabilities } from "./value-engine.server";

const SHARP_MOVE_MIN = 0.03;   // 3% odds move on Pinnacle
const MIN_DIVERGENCE = 0.025;  // 2.5% gap between sharp move and soft move

type Side = "home" | "draw" | "away";
type Prices = { home?: number; draw?: number; away?: number };

export interface SteamHit {
  selection: Side;
  sharpMove: number;   // + = odds shortened for this side on sharps
  softMove: number;
  divergence: number;
  sharpFairProb: number;
}

/** Move toward the side = (opening - current) / opening. Positive = money coming in. */
function moveToward(opening: number | undefined, current: number | undefined): number {
  if (!opening || !current) return 0;
  return (opening - current) / opening;
}

function avg(prices: (number | undefined)[]): number | undefined {
  const xs = prices.filter((p): p is number => typeof p === "number" && p > 0);
  if (!xs.length) return undefined;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export async function detectSteam(args: {
  matchId: string;
  market: string;
  openingPinn: Prices | undefined;
  currentPinn: Prices | undefined;
  softOpening: Prices;   // averaged opening across soft books
  softCurrent: Prices;   // averaged current across soft books
}): Promise<SteamHit[]> {
  const { openingPinn, currentPinn } = args;
  if (!openingPinn || !currentPinn) return [];
  const sharpFair = currentPinn.home && currentPinn.draw && currentPinn.away
    ? fairProbabilities(currentPinn.home, currentPinn.draw, currentPinn.away)
    : null;
  if (!sharpFair) return [];

  const hits: SteamHit[] = [];
  for (const side of ["home", "draw", "away"] as const) {
    const sharpMove = moveToward(openingPinn[side], currentPinn[side]);
    const softMove = moveToward(args.softOpening[side], args.softCurrent[side]);
    const divergence = sharpMove - softMove;
    if (sharpMove < SHARP_MOVE_MIN) continue;
    if (divergence < MIN_DIVERGENCE) continue;
    hits.push({
      selection: side,
      sharpMove,
      softMove,
      divergence,
      sharpFairProb: sharpFair[side],
    });
  }

  if (hits.length) {
    try {
      await supabaseAdmin.from("steam_signals").insert(hits.map((h) => ({
        match_id: args.matchId,
        market: args.market,
        selection: h.selection,
        sharp_move_pct: h.sharpMove,
        soft_move_pct: h.softMove,
        divergence: h.divergence,
        sharp_fair_prob: h.sharpFairProb,
      })));
    } catch (e) {
      console.warn("steam insert failed:", (e as Error).message);
    }
  }
  return hits;
}

/** Average soft-book opening + current prices across the H2H market. */
export function averageSoftPrices(
  books: { bookmaker: string; sharp: boolean; home?: number; draw?: number; away?: number }[],
  openingByBook: Map<string, Prices>,
): { softOpening: Prices; softCurrent: Prices } {
  const soft = books.filter((b) => !b.sharp);
  const softCurrent: Prices = {
    home: avg(soft.map((b) => b.home)),
    draw: avg(soft.map((b) => b.draw)),
    away: avg(soft.map((b) => b.away)),
  };
  const openings = soft.map((b) => openingByBook.get(b.bookmaker) ?? {});
  const softOpening: Prices = {
    home: avg(openings.map((o) => o.home)),
    draw: avg(openings.map((o) => o.draw)),
    away: avg(openings.map((o) => o.away)),
  };
  return { softOpening, softCurrent };
}