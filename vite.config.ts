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
            if (id.includes("node_modules")) {
              if (id.includes("recharts") || id.includes("d3-")) {
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
              if (id.includes("react") || id.includes("react-dom")) {
                return "vendor-react";
              }
              return "vendor-misc";
            }
          },
        },
      },
    },
  },
});
