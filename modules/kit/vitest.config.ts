import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"
import { fileURLToPath } from "node:url"

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.ts"],
  },
  resolve: {
    alias: {
      "@kit": fileURLToPath(new URL("./src", import.meta.url)),
      // @ionic/vue's barrel statically imports a few symbols from vue-router,
      // which kit (router-agnostic) does not depend on. Point them at an inert
      // stub so Ion-based components import under jsdom without a real router.
      "vue-router": fileURLToPath(
        new URL("./src/ui/__tests__/__stubs__/vue-router.ts", import.meta.url)
      ),
    },
  },
})
