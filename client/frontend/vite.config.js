import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Wails serves the built assets from frontend/dist.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
