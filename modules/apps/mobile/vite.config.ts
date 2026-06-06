import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import { kitVitePlugin } from "../../kit/vite.aliases"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
const dbScheme = JSON.parse(readFileSync(new URL("../../db-scheme.json", import.meta.url), "utf-8"))

// `@shruti` is also the npm scope for our in-house Capacitor plugins
// (`@shruti/plugin-*`, e.g. `@shruti/plugin-audio-player`). Vite 8
// uses Rolldown, which doesn't expand `$1` back-references in regex alias
// replacements — so we resolve the `@shruti/*` (excluding the
// `@shruti/plugin-*` family) prefix via a tiny plugin instead.
const SHRUTI_ROOT = path.resolve(__dirname, "./shruti")
const shrutiAlias = {
  name: "shruti-source-alias",
  enforce: "pre" as const,
  // Sources import e.g. "@shruti/router/index.js" but the file on disk is
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
    if (!id.startsWith("@shruti/") || id.startsWith("@shruti/plugin-")) return null
    const rewritten = path.resolve(SHRUTI_ROOT, id.slice("@shruti/".length))
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
    __REVENUECAT_IOS_KEY__: JSON.stringify(process.env.SHRUTI_APPLE_REVENUE_CAT_KEY ?? ""),
    __REVENUECAT_ANDROID_KEY__: JSON.stringify(process.env.SHRUTI_GOOGLE_REVENUE_CAT_KEY ?? ""),
    // Auth + chat base URLs are no longer baked in at build time — the
    // adapters resolve them at call time via
    // `() => shruti.activeServer.value.{auth,chat}BaseUrl` getters
    // declared in `modules/libs/domain/servers.ts`. Operators no longer
    // set SHRUTI_AUTH_API_BASE_URL / SHRUTI_CHAT_API_BASE_URL.
    // OAuth client IDs are public by design — Google embeds them in the APK
    // and they're recoverable via apktool. Hard-coded defaults so a fresh
    // checkout builds working sign-in without any env setup. Override via
    // env if staging / multi-tenant ever lands.
    __GOOGLE_WEB_CLIENT_ID__: JSON.stringify(
      process.env.SHRUTI_GOOGLE_WEB_CLIENT_ID ??
        ""
    ),
    __GOOGLE_IOS_CLIENT_ID__: JSON.stringify(
      process.env.SHRUTI_GOOGLE_IOS_CLIENT_ID ??
        ""
    ),
  },
  build: {
    minify: true,
    sourcemap: true,
    rollupOptions: { treeshake: true },
  },
  server: {
    host: "0.0.0.0",
    // Default 11001 = shruti's app dev port (workspace port convention,
    // 11xxx band). `VITE_PORT` overrides it — set per-project in the dotfiles
    // envrc and per-worktree by `make worktree-serve` (11100 + issue), which
    // were previously ignored because this was hard-coded.
    port: Number(process.env.VITE_PORT) || 11001,
    strictPort: true,
    allowedHosts: ["mobile.shruti.dev"],
  },
  plugins: [shrutiAlias, kitVitePlugin(path.resolve(__dirname, "../../kit/src")), vue()],
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
      { find: "@docs", replacement: path.resolve(__dirname, "./submodules/docs") },
    ],
  },
})
