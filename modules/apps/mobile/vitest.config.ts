import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"

const dbScheme = JSON.parse(
  readFileSync(new URL("../../db-scheme.json", import.meta.url), "utf-8")
)

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_ID__: JSON.stringify("test"),
    __DB_SCHEME__: JSON.stringify(dbScheme.scheme),
  },
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
  test: {
    environment: "node",
    include: [
      "submodules/domain/**/__tests__/**/*.test.ts",
      "submodules/application/**/__tests__/**/*.test.ts",
      "infra/**/__tests__/**/*.test.ts",
      "shruti/**/__tests__/**/*.test.ts",
    ],
  },
})
