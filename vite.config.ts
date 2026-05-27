import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;

            if (id.includes("recharts") || id.includes("/d3-")) {
              return "vendor-charts";
            }
            if (id.includes("@supabase")) {
              return "vendor-supabase";
            }
            if (id.includes("@tanstack")) {
              return "vendor-tanstack";
            }
            if (id.includes("@radix-ui")) {
              return "vendor-radix";
            }
            // Only match React core packages exactly — not react-hook-form etc.
            if (
              id.includes("/node_modules/react/") ||
              id.includes("/node_modules/react-dom/") ||
              id.includes("/node_modules/scheduler/")
            ) {
              return "vendor-react";
            }
            // Everything else: let Rollup decide naturally (no vendor-misc)
          },
        },
      },
    },
  },
});
