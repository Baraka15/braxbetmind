import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runBacktest } from "./backtest.server";

export const getBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      leagues: z.array(z.string().min(1).max(64)).max(30).optional(),
    }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    return await runBacktest({ leagues: data.leagues });
  });