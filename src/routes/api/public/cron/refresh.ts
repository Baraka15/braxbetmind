import { createFileRoute } from "@tanstack/react-router";
import { runRefresh } from "@/lib/refresh.server";

export const Route = createFileRoute("/api/public/cron/refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        const provided = request.headers.get("x-cron-secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          const summary = await runRefresh();
          return new Response(JSON.stringify(summary), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
