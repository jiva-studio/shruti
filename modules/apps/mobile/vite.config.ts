import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import { sentryVitePlugin } from "@sentry/vite-plugin"
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
// A build made for the automated tests. It is what lets the subscription
// override grant Pro at all (see shruti/services/devSubscription.ts), and it
// comes from the build environment — so the e2e artifact carries the seam that
// lets a spec pick its tier, and release artifacts, built without it, do not.
const e2eBuild = process.env.SHRUTI_E2E_BUILD === "1"

// Short git commit hash (CI passes github.sha), so the version line reveals
// exactly which commit a build came from. Empty locally / when not provided.
const commitSha = (process.env.COMMIT_SHA ?? "").slice(0, 7)

// Single source of truth for the Sentry release name. Used BOTH as the runtime
// SDK `release` (injected via __SENTRY_RELEASE__) and as the uploaded
// source-map artifact name (sentryVitePlugin below) — they MUST match or the
// maps won't resolve against incoming events.
const sentryRelease = commitSha
  ? `shruti@${pkg.version}+${commitSha}`
  : `shruti@${pkg.version}`

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
    // Public Sentry DSN — embed-by-design like the OAuth client IDs above, so
    // it ships with a hard-coded default and can be overridden via env. An
    // empty string disables Sentry (see shruti/services/monitoring).
    __SENTRY_DSN__: JSON.stringify(
      process.env.SENTRY_DSN ??
        ""
    ),
    // Release name shared with the source-map upload (see sentryRelease above).
    __SENTRY_RELEASE__: JSON.stringify(sentryRelease),
    // Off-store build (distributed as a sideloaded APK, not via Play). When
    // SHRUTI_OFFSTORE is set, the web bundle hides Google/Apple sign-in
    // (email OTP only), drops the onboarding paywall, and routes subscription
    // management to the website payment page — so the APK runs on devices
    // without Google services. The CI job that builds this APK also passes
    // empty REVENUECAT_* keys (purchase UI hides) and omits
    // google-services.json (no FCM).
    __OFFSTORE_BUILD__: JSON.stringify(
      process.env.SHRUTI_OFFSTORE === "1" || process.env.SHRUTI_OFFSTORE === "true"
    ),
    __E2E_BUILD__: JSON.stringify(e2eBuild),
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
  plugins: [
    shrutiAlias,
    // Leave a mark in `dist/` saying the bundle was built with the test seam
    // compiled in. `E2E_USE_BUNDLE=1` serves a PREBUILT dist, so the suite
    // otherwise has no way to tell a test build from a release one — and the
    // failure it can't tell apart is the silent one: every `pro: true` spec
    // running as a free user (#1633). The e2e globalSetup refuses to start
    // without this file. Emitted only under the flag, and `emptyOutDir` clears
    // it on the next ordinary build.
    ...(e2eBuild
      ? [
          {
            name: "shruti-e2e-build-marker",
            generateBundle(this: { emitFile(f: unknown): void }) {
              this.emitFile({ type: "asset", fileName: "e2e-build", source: "1" })
            },
          },
        ]
      : []),
    kitVitePlugin(path.resolve(__dirname, "../../kit/src")),
    vue(),
    // Upload JS source maps to Sentry so minified stack traces are
    // de-obfuscated. Active only when SENTRY_AUTH_TOKEN is present (CI) — local
    // `npm run build` has no token, so the plugin is omitted and the build runs
    // unchanged. The release name MUST equal the runtime SDK `release`
    // (sentryRelease, injected as __SENTRY_RELEASE__) for maps to resolve.
    // `.map` files are deleted from dist after upload so they never ship inside
    // the APK/IPA.
    ...(process.env.SENTRY_AUTH_TOKEN
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG ?? "akdasa-studio",
            project: process.env.SENTRY_PROJECT ?? "shruti",
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: { name: sentryRelease },
            sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
          }),
        ]
      : []),
  ],
  resolve: {
    preserveSymlinks: true,
    // `vue-router` MUST be deduped alongside the Ionic packages: components
    // import `useRoute`/`useRouter` from `vue-router`, and without a single
    // instance Vite's dev pre-bundling can mint a second copy whose inject
    // symbols don't match the one `app.use(router)` provided — surfacing as
    // `injection "Symbol(router)" not found` and a route that reads
    // `undefined` (which silently breaks the chat session-load watcher).
    //
    // The `@capacitor/*` packages are deduped for a second reason: kit's source
    // (`../../kit/src`, compiled in via kitVitePlugin) imports them, but kit
    // lives outside this app's tree so a bare resolve from a kit file can't walk
    // up to this app's node_modules. dedupe forces Vite to resolve them from the
    // project root (here), where they're installed — the same role the dropped
    // `modules/node_modules` symlink used to play.
    dedupe: [
      "vue",
      "vue-router",
      "@ionic/vue",
      "@ionic/core",
      "@ionic/vue-router",
      "@capacitor/core",
      "@capacitor/filesystem",
      "@capacitor/haptics",
      "@capacitor/local-notifications",
      "@capacitor/preferences",
      "@capacitor/share",
    ],
    alias: [
      { find: "@ports", replacement: path.resolve(__dirname, "./ports") },
      { find: "@infra", replacement: path.resolve(__dirname, "./infra") },
      { find: "@ui", replacement: path.resolve(__dirname, "./ui") },
      { find: "@lib/contracts", replacement: path.resolve(__dirname, "./submodules/contracts") },
      { find: "@lib/domain", replacement: path.resolve(__dirname, "./submodules/domain") },
      { find: "@lib/ui", replacement: path.resolve(__dirname, "./submodules/ui") },
      { find: "@lib/chat", replacement: path.resolve(__dirname, "./submodules/chat") },
      {
        find: "@usecases",
        replacement: path.resolve(__dirname, "./usecases"),
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
