import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"

const dbScheme = JSON.parse(readFileSync(new URL("../../db-scheme.json", import.meta.url), "utf-8"))

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_ID__: JSON.stringify("test"),
    __DB_SCHEME__: JSON.stringify(dbScheme.scheme),
    // Off-store flag referenced at module top-level (onboarding controller);
    // tests build the normal variant.
    __OFFSTORE_BUILD__: JSON.stringify(false),
    // Same for the test-build seam: unit tests compile the SHIPPED variant, so
    // devSubscription's prod-safety assertions are made against the real thing
    // (`__BUILD_ID__` is "test" above, i.e. not a dev build either).
    __E2E_BUILD__: JSON.stringify(false),
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      // The in-house Capacitor plugins share the `@shruti` npm scope
      // (`@shruti/plugin-*`) but live in node_modules, not under `./shruti`.
      // The broad `@shruti` alias below would otherwise rewrite them into
      // `./shruti/plugin-*` (nonexistent) — mirror vite.config's exclusion by
      // resolving the plugin packages explicitly first (more specific wins).
      // The media-downloader SUT imports the real module (not mocked), so point
      // it at the built ESM entry rather than the package dir.
      "@shruti/plugin-media-downloader": path.resolve(
        __dirname,
        "./node_modules/@shruti/plugin-media-downloader/dist/esm/index.js"
      ),
      "@shruti/plugin-audio-player": path.resolve(
        __dirname,
        "./node_modules/@shruti/plugin-audio-player"
      ),
      "@ports": path.resolve(__dirname, "./ports"),
      "@infra": path.resolve(__dirname, "./infra"),
      "@ui": path.resolve(__dirname, "./ui"),
      "@shruti": path.resolve(__dirname, "./shruti"),
      "@lib/contracts": path.resolve(__dirname, "./submodules/contracts"),
      "@lib/domain": path.resolve(__dirname, "./submodules/domain"),
      "@lib/ui": path.resolve(__dirname, "./submodules/ui"),
      "@lib/chat": path.resolve(__dirname, "./submodules/chat"),
      "@usecases": path.resolve(__dirname, "./usecases"),
      "@lib/persistence/main": path.resolve(__dirname, "./submodules/persistence-main"),
      "@lib/persistence/user": path.resolve(__dirname, "./submodules/persistence-user"),
      "@kit": path.resolve(__dirname, "../../kit/src"),
      // kit's source (compiled in via the @kit alias) imports these from the
      // consuming app's node_modules. It lives outside this app's tree, so a
      // bare resolve can't walk up to find them once the `modules/node_modules`
      // symlink is gone — point them here explicitly (mirrors the vite.config
      // dedupe and the tsconfig paths entries).
      "@ionic/vue": path.resolve(__dirname, "./node_modules/@ionic/vue"),
      "@capacitor": path.resolve(__dirname, "./node_modules/@capacitor"),
    },
  },
  test: {
    environment: "node",
    // Styles are stripped from SFCs by default, so a component whose defect IS
    // its CSS has nothing to assert against. Opt the badge's scoped block in so
    // its rules reach jsdom's cascade; keep the rest stripped.
    css: { include: [/IngestProgressBadge\.vue/] },
    include: [
      "submodules/domain/**/__tests__/**/*.test.ts",
      "submodules/contracts/**/__tests__/**/*.test.ts",
      "usecases/**/__tests__/**/*.test.ts",
      "infra/**/__tests__/**/*.test.ts",
      "shruti/**/__tests__/**/*.test.ts",
      "ui/**/__tests__/**/*.test.ts",
    ],
  },
})
