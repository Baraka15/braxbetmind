/**
 * Telegram alerts via the Lovable connector gateway.
 * Never call the Telegram Bot API directly — use the gateway URL pattern.
 */
const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");
  const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
  if (!TELEGRAM_API_KEY) throw new Error("TELEGRAM_API_KEY is not configured (connect Telegram in Connectors)");

  const res = await fetch(`${GATEWAY_URL}/sendMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": TELEGRAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed [${res.status}]: ${body.slice(0, 240)}`);
  }
}

export interface AlertBet {
  home: string;
  away: string;
  league: string | null;
  commence_time: string;
  market: string;
  selection: string;
  best_odds: number;
  bookmaker: string;
  ai_prob: number;
  edge_pct: number;
  kelly_stake_pct: number;
  confidence_tier: string;
}

export function formatAlertMessage(b: AlertBet): string {
  const kickoff = new Date(b.commence_time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return [
    `<b>🎯 Value bet — ${b.confidence_tier} tier</b>`,
    `${b.home} vs ${b.away}`,
    b.league ? `<i>${b.league}</i>` : "",
    `Kickoff: ${kickoff}`,
    "",
    `Pick: <b>${b.market.toUpperCase()} ${b.selection.toUpperCase()}</b>`,
    `Odds: <b>${b.best_odds.toFixed(2)}</b> @ ${b.bookmaker}`,
    `Model: ${(b.ai_prob * 100).toFixed(1)}%   Edge: <b>+${(b.edge_pct * 100).toFixed(2)}%</b>`,
    `Suggested stake: ${(b.kelly_stake_pct * 100).toFixed(2)}% of bankroll`,
    "",
    "<i>Statistical estimate only. Bet responsibly.</i>",
  ].filter(Boolean).join("\n");
}