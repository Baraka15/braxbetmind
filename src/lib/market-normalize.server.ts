/**
 * Explicit odds/market normalization for 1X2, Over/Under totals, and BTTS.
 *
 * Different feeds (Odds API, ESPN, TheSportsDB, football-data, cached rows)
 * describe the same market with slightly different strings — "Draw" vs "Tie"
 * vs "X", "Over"/"Under" vs "O"/"U" vs "Mais"/"Menos", team names with or
 * without accents/legal suffixes ("FC", "CF", "AFC"), point values as either
 * numbers or strings. This module collapses all of that into ONE canonical
 * shape that the ensemble and edge math consume:
 *
 *   NormalizedBook = { bookmaker, sharp, h2h?, totals?, btts? }
 *
 * It ALSO exposes market-specific de-vig helpers so 1X2, totals and BTTS
 * are all converted to fair probabilities the same way — proportional
 * (multiplicative) overround removal, with input validation. Downstream
 * consumers should never call `1/odds` directly on raw feed prices; they
 * should either take `NormalizedBook.h2h.home` etc. or the fair probs from
 * `devig1x2 / devigTotals / devigBtts`.
 */
import type { OddsApiEvent, OddsApiBookmaker } from "./odds-api.server";
import { isSharpBook } from "./odds-api.server";

// ─── team-name canonicalization ────────────────────────────────────────────
const LEGAL_SUFFIXES = [
  "fc", "afc", "cf", "sc", "ac", "if", "sk", "bk", "cd", "cd.", "ud",
  "sd", "rc", "cp", "ec", "kf", "fk", "ks", "hk", "us", "as", "ss",
  "lfc", "cfc", "ffc", "hfc", "united", "utd", "city",
];

function stripAccents(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Fold to a canonical key: lowercase, no accents/punct, no legal suffixes. */
export function canonicalTeam(name: string): string {
  const base = stripAccents(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = base.split(" ").filter((t) => t && !LEGAL_SUFFIXES.includes(t));
  return tokens.join(" ");
}

/** Return "home" | "away" | "draw" | null for an outcome name. */
export function classifyOutcome(
  outcomeName: string,
  homeTeam: string,
  awayTeam: string,
): "home" | "away" | "draw" | null {
  const raw = outcomeName.trim();
  const lower = raw.toLowerCase();
  if (
    lower === "draw" || lower === "tie" || lower === "x" ||
    lower === "the draw" || lower === "empate" || lower === "égalité" ||
    lower === "unentschieden" || lower === "pareggio" || lower === "remis" ||
    lower === "nul" || lower === "нич" || lower === "ничья"
  ) return "draw";
  const c = canonicalTeam(raw);
  const h = canonicalTeam(homeTeam);
  const a = canonicalTeam(awayTeam);
  if (!c) return null;
  if (c === h || h.includes(c) || c.includes(h)) return "home";
  if (c === a || a.includes(c) || c.includes(a)) return "away";
  return null;
}

/** Classify a totals leg by name; returns "over" | "under" | null. */
function classifyOu(name: string): "over" | "under" | null {
  const s = name.trim().toLowerCase();
  if (s === "over" || s === "o" || s === "mais" || s === "más" || s === "mas" || s.startsWith("over ")) return "over";
  if (s === "under" || s === "u" || s === "menos" || s.startsWith("under ")) return "under";
  return null;
}

/** Classify a BTTS leg by name; returns "yes" | "no" | null. */
function classifyBtts(name: string): "yes" | "no" | null {
  const s = name.trim().toLowerCase();
  if (s === "yes" || s === "gg" || s === "goal goal" || s === "both teams to score" || s === "both teams to score - yes") return "yes";
  if (s === "no" || s === "ng" || s === "no goal" || s === "both teams to score - no") return "no";
  return null;
}

/** Point coercion + snap to the standard 0.5 grid so "2.5" and 2.5 collide. */
function normalizePoint(p: unknown): number | null {
  const n = typeof p === "string" ? parseFloat(p) : typeof p === "number" ? p : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 2) / 2;
}

/** Reject obviously broken decimal prices. */
function isSanePrice(p: unknown): p is number {
  return typeof p === "number" && Number.isFinite(p) && p > 1.01 && p < 1000;
}

// ─── normalized shape ──────────────────────────────────────────────────────

export interface NormalizedBook {
  bookmaker: string;
  sharp: boolean;
  lastUpdate?: string;
  h2h?: { home: number; draw: number; away: number };
  totals?: { point: number; over: number; under: number }[];
  btts?: { yes: number; no: number };
}

/** Normalize every bookmaker on an event to the canonical `NormalizedBook`. */
export function normalizeEventBooks(ev: OddsApiEvent): NormalizedBook[] {
  const out: NormalizedBook[] = [];
  for (const bk of ev.bookmakers) {
    const row = normalizeBookmaker(bk, ev.home_team, ev.away_team);
    if (row) out.push(row);
  }
  return out;
}

export function normalizeBookmaker(
  bk: OddsApiBookmaker,
  homeTeam: string,
  awayTeam: string,
): NormalizedBook | null {
  const row: NormalizedBook = {
    bookmaker: bk.key,
    sharp: isSharpBook(bk.key),
    lastUpdate: bk.last_update,
  };

  const h2h = bk.markets.find((m) => m.key === "h2h" || m.key === "moneyline" || m.key === "1x2");
  if (h2h) {
    let home: number | undefined, draw: number | undefined, away: number | undefined;
    for (const o of h2h.outcomes) {
      if (!isSanePrice(o.price)) continue;
      const cls = classifyOutcome(o.name, homeTeam, awayTeam);
      if (cls === "home") home = o.price;
      else if (cls === "away") away = o.price;
      else if (cls === "draw") draw = o.price;
    }
    if (home && draw && away) row.h2h = { home, draw, away };
  }

  const totals = bk.markets.find((m) => m.key === "totals" || m.key === "total" || m.key === "ou");
  if (totals) {
    const byPoint = new Map<number, { over?: number; under?: number }>();
    for (const o of totals.outcomes as Array<{ name: string; price: number; point?: unknown }>) {
      const pt = normalizePoint(o.point);
      if (pt === null || !isSanePrice(o.price)) continue;
      const side = classifyOu(o.name);
      if (!side) continue;
      const slot = byPoint.get(pt) ?? {};
      slot[side] = o.price;
      byPoint.set(pt, slot);
    }
    const arr = [...byPoint.entries()]
      .filter(([, v]) => v.over && v.under)
      .map(([point, v]) => ({ point, over: v.over!, under: v.under! }))
      .sort((a, b) => a.point - b.point);
    if (arr.length) row.totals = arr;
  }

  const btts = bk.markets.find((m) => m.key === "btts" || m.key === "both_teams_to_score");
  if (btts) {
    let yes: number | undefined, no: number | undefined;
    for (const o of btts.outcomes) {
      if (!isSanePrice(o.price)) continue;
      const side = classifyBtts(o.name);
      if (side === "yes") yes = o.price;
      else if (side === "no") no = o.price;
    }
    if (yes && no) row.btts = { yes, no };
  }

  if (!row.h2h && !row.totals && !row.btts) return null;
  return row;
}

// ─── de-vig helpers (consistent proportional method across all markets) ────

export function devig1x2(o: { home: number; draw: number; away: number }) {
  const ih = 1 / o.home, id = 1 / o.draw, ia = 1 / o.away;
  const s = ih + id + ia;
  return { home: ih / s, draw: id / s, away: ia / s, overround: s - 1 };
}

export function devigTotals(o: { over: number; under: number }) {
  const io = 1 / o.over, iu = 1 / o.under;
  const s = io + iu;
  return { over: io / s, under: iu / s, overround: s - 1 };
}

export function devigBtts(o: { yes: number; no: number }) {
  const iy = 1 / o.yes, in_ = 1 / o.no;
  const s = iy + in_;
  return { yes: iy / s, no: in_ / s, overround: s - 1 };
}

/** Sharp-consensus fair probs across a filtered book set for 1X2. */
export function consensusFair1x2(books: NormalizedBook[]) {
  const rows = books.filter((b) => b.h2h).map((b) => b.h2h!);
  if (!rows.length) return null;
  let h = 0, d = 0, a = 0;
  for (const r of rows) {
    const f = devig1x2(r);
    h += f.home; d += f.draw; a += f.away;
  }
  return { home: h / rows.length, draw: d / rows.length, away: a / rows.length };
}