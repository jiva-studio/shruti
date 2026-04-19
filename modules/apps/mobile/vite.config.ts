import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"
import { defineConfig } from "vite"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
const dbScheme = JSON.parse(readFileSync(new URL("../../db-scheme.json", import.meta.url), "utf-8"))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? "dev"),
    __DB_SCHEME__: JSON.stringify(dbScheme.scheme),
  },
  build: {
    minify: true,
    sourcemap: true,
    rollupOptions: { treeshake: true },
  },
  server: {
    host: "0.0.0.0",
    port: 8102,
    allowedHosts: ["mobile.shruti.dev"],
  },
  plugins: [vue()],
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@ports": path.resolve(__dirname, "./ports"),
      "@infra": path.resolve(__dirname, "./infra"),
      "@ui": path.resolve(__dirname, "./ui"),
      "@shruti": path.resolve(__dirname, "./shruti"),
      "@lib/domain": path.resolve(__dirname, "./submodules/domain"),
      "@lib/application": path.resolve(__dirname, "./submodules/application"),
      "@lib/persistence/main": path.resolve(__dirname, "./submodules/persistence-main"),
      "@lib/persistence/user": path.resolve(__dirname, "./submodules/persistence-user"),
    },
  },
})
