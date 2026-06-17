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
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@ports": path.resolve(__dirname, "./ports"),
      "@infra": path.resolve(__dirname, "./infra"),
      "@ui": path.resolve(__dirname, "./ui"),
      // The in-house Capacitor plugins share the `@lectorium` npm scope
      // (`@lectorium/plugin-*`) but live in node_modules, not under `./lectorium`.
      // The broad `@lectorium` alias below would otherwise rewrite them into
      // `./lectorium/plugin-*` (nonexistent) — mirror vite.config's exclusion by
      // resolving the plugin packages explicitly first (more specific wins).
      "@lectorium/plugin-media-downloader": path.resolve(
        __dirname,
        "./node_modules/@lectorium/plugin-media-downloader"
      ),
      "@lectorium/plugin-audio-player": path.resolve(
        __dirname,
        "./node_modules/@lectorium/plugin-audio-player"
      ),
      "@lectorium": path.resolve(__dirname, "./lectorium"),
      "@lib/domain": path.resolve(__dirname, "./submodules/domain"),
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
    include: [
      "submodules/domain/**/__tests__/**/*.test.ts",
      "usecases/**/__tests__/**/*.test.ts",
      "infra/**/__tests__/**/*.test.ts",
      "lectorium/**/__tests__/**/*.test.ts",
    ],
  },
})
