import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@lib/contracts": path.resolve(__dirname, "../../libs/contracts/index.ts"),
      "@lib": path.resolve(__dirname, "../../libs"),
      // Library source lives outside this package, so a bare `vue` import from
      // it would not find this package's node_modules.
      vue: path.resolve(__dirname, "./node_modules/vue"),
    },
  },
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
  },
})
