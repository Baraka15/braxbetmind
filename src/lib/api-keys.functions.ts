import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, name, prefix, rate_limit_per_min, last_used_at, revoked_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({
    name: z.string().trim().min(1).max(64),
    rate_limit_per_min: z.number().int().min(1).max(600).default(60),
  }).parse(input))
  .handler(async ({ data, context }) => {
    const { generateApiKey } = await import("./api-auth.server");
    const { plaintext, hash, prefix } = generateApiKey();
    const { data: row, error } = await context.supabase
      .from("api_keys")
      .insert({
        user_id: context.userId,
        name: data.name,
        prefix,
        key_hash: hash,
        rate_limit_per_min: data.rate_limit_per_min,
      })
      .select("id, name, prefix, rate_limit_per_min, created_at")
      .single();
    if (error) throw new Error(error.message);
    // Plaintext returned once — never stored.
    return { ...row, plaintext };
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });