import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import { kitVitePlugin } from "../../kit/vite.aliases"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
const dbScheme = JSON.parse(readFileSync(new URL("../../db-scheme.json", import.meta.url), "utf-8"))

// CI passes the raw GITHUB_RUN_NUMBER as BUILD_ID. The store versionCode is
// that number + `versionCodeOffset` (applied by fastlane). Apply the same
// offset here so the build id shown in Settings matches the shipped build
// (otherwise Settings showed e.g. "15" for a "2015" build). Unset locally →
// "dev", which usePurchasesStore relies on to detect dev builds — preserve it.
const rawBuildId = process.env.BUILD_ID
const buildId =
  rawBuildId && /^\d+$/.test(rawBuildId)
    ? String(Number(rawBuildId) + (pkg.versionCodeOffset ?? 0))
    : (rawBuildId ?? "dev")
// Short git commit hash (CI passes github.sha), so the version line reveals
// exactly which commit a build came from. Empty locally / when not provided.
const commitSha = (process.env.COMMIT_SHA ?? "").slice(0, 7)

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
    __BUILD_ID__: JSON.stringify(buildId),
    __COMMIT_SHA__: JSON.stringify(commitSha),
    __DB_SCHEME__: JSON.stringify(dbScheme.scheme),
    // Public RevenueCat SDK keys (appl_…/goog_…), baked into the bundle at
    // build time. Generic env names so BOTH build paths feed them the same
    // way: the app's own web build (apps-mobile.yml) and kit's reusable
    // native-binary build (mobile-binaries.yml) each map the
    // SHRUTI_*_REVENUE_CAT_KEY repo secrets onto these. An empty key →
    // `available: false` → the SDK is never touched and the subscription UI
    // hides itself (the exact symptom when a build path forgets to pass them).
    __REVENUECAT_IOS_KEY__: JSON.stringify(process.env.REVENUECAT_IOS_KEY ?? ""),
    __REVENUECAT_ANDROID_KEY__: JSON.stringify(process.env.REVENUECAT_ANDROID_KEY ?? ""),
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
    // `vue-router` MUST be deduped alongside the Ionic packages: components
    // import `useRoute`/`useRouter` from `vue-router`, and without a single
    // instance Vite's dev pre-bundling can mint a second copy whose inject
    // symbols don't match the one `app.use(router)` provided — surfacing as
    // `injection "Symbol(router)" not found` and a route that reads
    // `undefined` (which silently breaks the chat session-load watcher).
    dedupe: ["vue", "vue-router", "@ionic/vue", "@ionic/core", "@ionic/vue-router"],
    alias: [
      { find: "@ports", replacement: path.resolve(__dirname, "./ports") },
      { find: "@infra", replacement: path.resolve(__dirname, "./infra") },
      { find: "@ui", replacement: path.resolve(__dirname, "./ui") },
      { find: "@lib/contracts", replacement: path.resolve(__dirname, "./submodules/contracts") },
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
