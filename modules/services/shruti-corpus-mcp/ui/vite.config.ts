import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Each build pass bundles ONE player HTML (INPUT env) into a single
// self-contained file — App class + zod + sdk all inlined, no external imports
// (the host renders us in a deny-by-default sandbox that blocks external loads).
// Output lands in internal/mcp/dist/ so the Go service can go:embed it.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "../internal/mcp/dist",
    emptyOutDir: false,
    target: "es2020",
    rollupOptions: {
      input: process.env.INPUT,
    },
  },
});
