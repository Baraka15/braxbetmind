import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runCsvBacktest } from "./backtest-csv.server";

export const runCsvBacktestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      csv: z.string().min(20).max(5_000_000),
      minEdge: z.number().min(0).max(1).default(0.05),
      kellyFraction: z.number().min(0).max(1).default(0.25),
      startingBankroll: z.number().min(1).max(10_000_000).default(1000),
    }).parse(input),
  )
  .handler(async ({ data }) => runCsvBacktest(data));