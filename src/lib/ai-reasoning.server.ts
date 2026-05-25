/**
 * Lovable AI reasoning layer — synthesises every quant signal into a
 * confidence tier (S/A/B/C) and a short plain-English rationale.
 * Uses structured tool-calling so the output is deterministic.
 */

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

export interface ReasoningInput {
  home: string;
  away: string;
  league: string;
  market: string;
  selection: string;
  bestOdds: number;
  bookmaker: string;
  layers: {
    poisson: number;
    dixonColes: number;
    elo: number;
    marketConsensus: number;
    sharpVsSoftDelta: number; // + = sharps lean toward this selection
    lineMovement: number; // % move toward this selection (negative = away from)
  };
  finalProb: number;
  edgePct: number;
}

export interface ReasoningOutput {
  tier: "S" | "A" | "B" | "C";
  rationale: string;
  adjustedProb: number; // model may tweak by up to ±3 pts
}

export async function reason(input: ReasoningInput): Promise<ReasoningOutput | null> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) return null;

  const body = {
    model: "google/gemini-3-flash-preview",
    messages: [
      {
        role: "system",
        content:
          "You are a senior football betting quant. You receive ensemble model outputs and assign a confidence tier (S=elite, A=strong, B=solid, C=marginal) and write a one-sentence rationale (max 25 words) referencing the strongest 1-2 signals. You may adjust the final probability by at most ±3 percentage points based on signal agreement.",
      },
      {
        role: "user",
        content: JSON.stringify(input),
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "assign_confidence",
          description: "Return tier, adjusted probability, and rationale.",
          parameters: {
            type: "object",
            properties: {
              tier: { type: "string", enum: ["S", "A", "B", "C"] },
              adjusted_prob: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string", maxLength: 200 },
            },
            required: ["tier", "adjusted_prob", "rationale"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "assign_confidence" } },
  };

  try {
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("AI reasoning failed:", res.status);
      return null;
    }
    const data = await res.json();
    const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;
    const parsed = JSON.parse(args);
    return {
      tier: parsed.tier,
      rationale: parsed.rationale,
      adjustedProb: parsed.adjusted_prob,
    };
  } catch (e) {
    console.warn("AI reasoning error:", (e as Error).message);
    return null;
  }
}