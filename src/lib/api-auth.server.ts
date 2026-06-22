import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, Authorization",
  "Access-Control-Max-Age": "86400",
} as const;

export const PUBLIC_API_CORS = CORS;

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a new API key with `bm_` prefix. Returns plaintext + hash + prefix. */
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const body = randomBytes(24).toString("base64url");
  const plaintext = `bm_${body}`;
  return { plaintext, hash: hashApiKey(plaintext), prefix: plaintext.slice(0, 10) };
}

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Validate the X-Api-Key header against `api_keys` and consume a rate-limit
 * slot. Returns the owning user_id on success, or a Response on failure.
 */
export async function authenticateApiRequest(request: Request): Promise<
  { userId: string } | { error: Response }
> {
  const raw = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) return { error: jsonResponse({ error: "Missing X-Api-Key header" }, 401) };
  const hash = hashApiKey(raw.trim());
  const { data, error } = await supabaseAdmin.rpc("consume_api_key", { _hash: hash });
  if (error) return { error: jsonResponse({ error: "Auth check failed" }, 500) };
  if (!data) return { error: jsonResponse({ error: "Invalid key or rate limit exceeded" }, 429) };
  return { userId: data as string };
}