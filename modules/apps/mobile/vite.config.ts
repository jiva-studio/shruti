import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"
import { defineConfig } from "vite"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
const dbScheme = JSON.parse(readFileSync(new URL("../../db-scheme.json", import.meta.url), "utf-8"))

// `@lectorium` is also the npm scope for our audio-player plugin
// (`@lectorium/audio-player`). Vite 8 uses Rolldown, which doesn't expand
// `$1` back-references in regex alias replacements — so we resolve the
// `@lectorium/*` (excluding `@lectorium/audio-player`) prefix via a tiny
// plugin instead.
const LECTORIUM_ROOT = path.resolve(__dirname, "./lectorium")
const lectoriumAlias = {
  name: "lectorium-source-alias",
  enforce: "pre" as const,
  // Sources import e.g. "@lectorium/router/index.js" but the file on disk is
  // index.ts. Re-call Vite's resolver after rewriting so extension fallback
  // kicks in (.ts/.tsx/.vue/index.*).
  async resolveId(
    this: {
      resolve: (
        id: string,
        importer?: string,
        opts?: { skipSelf?: boolean }
      ) => Promise<{ id: string } | null>
    },
    id: string,
    importer?: string
  ) {
    if (!id.startsWith("@lectorium/") || id.startsWith("@lectorium/audio-player")) return null
    const rewritten = path.resolve(LECTORIUM_ROOT, id.slice("@lectorium/".length))
    const resolved = await this.resolve(rewritten, importer, { skipSelf: true })
    return resolved?.id ?? rewritten
  },
}

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
    port: 11001,
    strictPort: true,
    allowedHosts: ["mobile.lectorium.dev"],
  },
  plugins: [lectoriumAlias, vue()],
  resolve: {
    preserveSymlinks: true,
    alias: [
      { find: "@ports", replacement: path.resolve(__dirname, "./ports") },
      { find: "@infra", replacement: path.resolve(__dirname, "./infra") },
      { find: "@ui", replacement: path.resolve(__dirname, "./ui") },
      { find: "@lib/domain", replacement: path.resolve(__dirname, "./submodules/domain") },
      {
        find: "@lib/application",
        replacement: path.resolve(__dirname, "./submodules/application"),
      },
      {
        find: "@lib/persistence/main",
        replacement: path.resolve(__dirname, "./submodules/persistence-main"),
      },
      {
        find: "@lib/persistence/user",
        replacement: path.resolve(__dirname, "./submodules/persistence-user"),
      },
    ],
  },
})
