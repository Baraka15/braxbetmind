/**
 * Bet settlement: after kickoff, look up the real result and mark each bet
 * won / lost / void. Computes realized P&L in units (1 unit = full stake).
 *
 * pnl_units: won = best_odds - 1, lost = -1, void = 0.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchFinishedMatches } from "./football-data.server";

type Status = "pending" | "won" | "lost" | "void";

interface MatchRow {
  id: string;
  home: string;
  away: string;
  commence_time: string;
  sport_key: string;
}

interface ResultRow {
  home_team: string;
  away_team: string;
  home_goals: number;
  away_goals: number;
  played_at: string;
}

function norm(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(fc|cf|sc|ca|cd|ec|se|af|bk|fk|if|is|aif|rb|cr|club|clube|de|da|do|del|la|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameTeam(a: string, b: string) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) return true;
  const aTokens = new Set(na.split(" ").filter((t) => t.length > 2));
  const bTokens = nb.split(" ").filter((t) => t.length > 2);
  return bTokens.length > 0 && bTokens.some((t) => aTokens.has(t));
}

function settleSelection(
  market: string,
  selection: string,
  hg: number,
  ag: number,
): { status: Status; actual: string } {
  const total = hg + ag;
  const outcome = hg > ag ? "home" : hg < ag ? "away" : "draw";
  const actual = `${hg}-${ag} (${outcome})`;
  switch (market) {
    case "h2h":
      return { status: selection === outcome ? "won" : "lost", actual };
    case "ou_1_5":
      return { status: (selection === "over" ? total > 1.5 : total < 1.5) ? "won" : "lost", actual };
    case "ou_2_5":
      return { status: (selection === "over" ? total > 2.5 : total < 2.5) ? "won" : "lost", actual };
    case "ou_3_5":
      return { status: (selection === "over" ? total > 3.5 : total < 3.5) ? "won" : "lost", actual };
    case "btts": {
      const both = hg > 0 && ag > 0;
      return { status: (selection === "yes" ? both : !both) ? "won" : "lost", actual };
    }
    case "dc": {
      const win =
        (selection === "1X" && (outcome === "home" || outcome === "draw")) ||
        (selection === "12" && (outcome === "home" || outcome === "away")) ||
        (selection === "X2" && (outcome === "draw" || outcome === "away"));
      return { status: win ? "won" : "lost", actual };
    }
    case "dnb":
      if (outcome === "draw") return { status: "void", actual };
      return { status: selection === outcome ? "won" : "lost", actual };
    default:
      return { status: "void", actual };
  }
}

export async function runSettlement() {
  const summary = { checked: 0, settled: 0, won: 0, lost: 0, void: 0, missing: 0 };

  // Pending bets for matches that have already kicked off.
  const { data: pending, error } = await supabaseAdmin
    .from("bets")
    .select("id, match_id, market, selection, best_odds, matches!inner(id, home, away, commence_time, sport_key)")
    .eq("status", "pending")
    .lt("matches.commence_time", new Date().toISOString())
    .limit(500);
  if (error) throw new Error(error.message);
  if (!pending?.length) return summary;

  // Refresh results for each sport_key involved.
  const sports = [...new Set(pending.map((b) => (b.matches as unknown as MatchRow).sport_key))];
  for (const sk of sports) {
    try { await fetchFinishedMatches(sk); } catch { /* ignore */ }
  }

  for (const bet of pending) {
    summary.checked++;
    const m = bet.matches as unknown as MatchRow;
    const kickoff = new Date(m.commence_time).getTime();
    const windowStart = new Date(kickoff - 12 * 3600 * 1000).toISOString();
    const windowEnd = new Date(kickoff + 36 * 3600 * 1000).toISOString();

    const { data: candidates } = await supabaseAdmin
      .from("match_results")
      .select("home_team, away_team, home_goals, away_goals, played_at")
      .eq("sport_key", m.sport_key)
      .gte("played_at", windowStart)
      .lte("played_at", windowEnd);

    const result = (candidates as ResultRow[] | null)?.find(
      (r) => sameTeam(r.home_team, m.home) && sameTeam(r.away_team, m.away),
    );
    if (!result) { summary.missing++; continue; }

    const { status, actual } = settleSelection(bet.market, bet.selection ?? "", result.home_goals, result.away_goals);
    const pnl = status === "won" ? Number(bet.best_odds) - 1 : status === "lost" ? -1 : 0;

    await supabaseAdmin.from("bets").update({
      status, actual_result: actual, pnl_units: pnl, settled_at: new Date().toISOString(),
    }).eq("id", bet.id);
    await supabaseAdmin.from("matches").update({ status: "played", updated_at: new Date().toISOString() }).eq("id", m.id);

    summary.settled++;
    if (status === "won") summary.won++;
    else if (status === "lost") summary.lost++;
    else summary.void++;
  }

  return summary;
}