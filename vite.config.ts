import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // G6 4.x pulls a large @antv graph-rendering stack. It is split into
    // stable vendor chunks below; keep the warning threshold aligned with that
    // known dependency cost so warnings remain actionable.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      input: {
        main: "index.html",
        app: "sql2er.html",
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@antv/g6")) {
            return "vendor-g6";
          }
          if (id.includes("node_modules/@antv/")) return "vendor-antv";
          if (
            id.includes("node_modules/d3-") ||
            id.includes("node_modules/dagre") ||
            id.includes("node_modules/graphlib")
          ) {
            return "vendor-antv";
          }
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "vendor-react";
          }
          if (
            id.includes("node_modules/codemirror") ||
            id.includes("node_modules/@codemirror") ||
            id.includes("node_modules/@lezer")
          ) {
            return "vendor-editor";
          }
          if (id.includes("node_modules/prismjs")) {
            return "vendor-prism";
          }
        },
      },
    },
  },
});
