/**
 * Optional helper for consumers that import kit's `@kit/*` source through Vite.
 *
 * Plain `resolve.alias` doesn't reliably resolve `.vue`/extensionless imports
 * through an alias, so this exports a tiny Vite plugin that re-runs Vite's
 * resolver with extension fallback (.ts/.tsx/.vue/index.*).
 *
 * The consumer passes the absolute path to kit's `src` directory — kit makes no
 * assumption about where it lives in the consuming repo:
 *
 *     import path from "node:path"
 *     import { kitVitePlugin } from "<path-to-kit>/vite.aliases"
 *     export default defineConfig({
 *       plugins: [kitVitePlugin(path.resolve(__dirname, "<…>/kit/src")), vue()],
 *     })
 *
 * Add the matching tsconfig path manually: `"@kit/*": ["<…>/kit/src/*"]`.
 */
import path from "node:path"

const PREFIX = "@kit/"

/** Static `@kit` → src alias map (no extension fallback) — handy for vitest etc. */
export function kitAliases(kitSrcDir: string): Record<string, string> {
  return { "@kit": kitSrcDir }
}

/** Minimal shape of Vite's plugin-context `resolve`, typed to avoid a hard vite dep. */
type ResolveFn = (
  source: string,
  importer: string | undefined,
  options: { skipSelf: boolean }
) => Promise<{ id: string } | null>

/**
 * Vite plugin resolving `@kit/*` with `.ts/.tsx/.vue/index.*` fallback.
 * `kitSrcDir` is the absolute path to kit's `src` directory.
 */
export function kitVitePlugin(kitSrcDir: string) {
  return {
    name: "kit-alias",
    enforce: "pre" as const,
    async resolveId(this: { resolve: ResolveFn }, id: string, importer?: string) {
      if (!id.startsWith(PREFIX)) return null
      const rewritten = path.join(kitSrcDir, id.slice(PREFIX.length))
      const resolved = await this.resolve(rewritten, importer, { skipSelf: true })
      return resolved?.id ?? rewritten
    },
  }
}
