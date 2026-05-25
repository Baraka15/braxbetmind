/**
 * Derive every supported market's probability from a goal-score matrix.
 */
import type { ScoreMatrix } from "./dixon-coles.server";

export type MarketKey =
  | "h2h" // home / draw / away
  | "ou_1_5" | "ou_2_5" | "ou_3_5"
  | "btts"
  | "dc" // double chance: 1X, 12, X2
  | "dnb"; // draw no bet: home or away

export interface MarketProbs {
  market: MarketKey;
  selections: Record<string, number>; // selection name -> probability
}

export function deriveMarkets(sm: ScoreMatrix): MarketProbs[] {
  const m = sm.matrix;
  const N = m.length;

  let pHome = 0, pDraw = 0, pAway = 0;
  let pOver15 = 0, pOver25 = 0, pOver35 = 0;
  let pBttsYes = 0;

  for (let h = 0; h < N; h++) {
    for (let a = 0; a < N; a++) {
      const p = m[h][a];
      if (h > a) pHome += p;
      else if (h < a) pAway += p;
      else pDraw += p;
      const goals = h + a;
      if (goals > 1) pOver15 += p;
      if (goals > 2) pOver25 += p;
      if (goals > 3) pOver35 += p;
      if (h > 0 && a > 0) pBttsYes += p;
    }
  }

  const pUnder15 = 1 - pOver15;
  const pUnder25 = 1 - pOver25;
  const pUnder35 = 1 - pOver35;
  const pBttsNo = 1 - pBttsYes;

  // Double chance + DNB derived from 1X2
  const p1X = pHome + pDraw;
  const p12 = pHome + pAway;
  const pX2 = pDraw + pAway;
  const dnbDenom = pHome + pAway;
  const dnbHome = dnbDenom > 0 ? pHome / dnbDenom : 0.5;
  const dnbAway = dnbDenom > 0 ? pAway / dnbDenom : 0.5;

  return [
    { market: "h2h", selections: { home: pHome, draw: pDraw, away: pAway } },
    { market: "ou_1_5", selections: { over: pOver15, under: pUnder15 } },
    { market: "ou_2_5", selections: { over: pOver25, under: pUnder25 } },
    { market: "ou_3_5", selections: { over: pOver35, under: pUnder35 } },
    { market: "btts", selections: { yes: pBttsYes, no: pBttsNo } },
    { market: "dc", selections: { "1X": p1X, "12": p12, X2: pX2 } },
    { market: "dnb", selections: { home: dnbHome, away: dnbAway } },
  ];
}

/** Pretty labels for the dashboard. */
export const MARKET_LABEL: Record<MarketKey, string> = {
  h2h: "1X2",
  ou_1_5: "Over/Under 1.5",
  ou_2_5: "Over/Under 2.5",
  ou_3_5: "Over/Under 3.5",
  btts: "Both Teams to Score",
  dc: "Double Chance",
  dnb: "Draw No Bet",
};

export const SELECTION_LABEL: Record<string, string> = {
  home: "Home",
  draw: "Draw",
  away: "Away",
  over: "Over",
  under: "Under",
  yes: "Yes",
  no: "No",
  "1X": "Home or Draw",
  "12": "Home or Away",
  X2: "Draw or Away",
};