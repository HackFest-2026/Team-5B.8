import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: { port: 5173, host: true },
  build: {
    outDir: "dist",
    // Sourcemaps are built but NOT shipped: `hidden` still writes the .map
    // files for local debugging and keeps the `//# sourceMappingURL` comment
    // out of the bundles, so browsers never request them. The deploy step
    // excludes them, which took the published site from 4.2MB to ~1.2MB and
    // stopped publishing the full source.
    sourcemap: "hidden",
  },
});
