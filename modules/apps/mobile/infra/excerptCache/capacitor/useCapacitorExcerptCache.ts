import { Directory, Filesystem } from "@capacitor/filesystem"
import type { IExcerptCache } from "@ports/app/excerptCache.js"

const DEFAULT_PROBE_TIMEOUT_MS = 1500

/**
 * `IExcerptCache` backed by `@capacitor/filesystem` + `fetch` HEAD.
 *
 * Cache layout: `Directory.Cache` root, flat — no subdirectories. The
 * legacy `Filesystem.downloadFile` on Android does NOT create
 * intermediate directories (iOS does), so a subdir would make the first
 * share fail with `FileNotFoundException`.
 *
 * `findLocal` uses `stat → catch → null` because Capacitor's stat
 * throws on missing files rather than returning a flag.
 *
 * `download` is followed by `getUri` to normalize the returned shape:
 * Android's downloadFile returns a raw absolute path
 * (`/data/user/0/.../cache/...`) without a scheme, which
 * `@capacitor/share` can't pipe through FileProvider — the share sheet
 * silently no-ops. `getUri` wraps it in `file://...`, which iOS
 * already returns from downloadFile so both platforms align.
 */
export function useCapacitorExcerptCache(): IExcerptCache {
  return {
    async findLocal(filename: string): Promise<string | null> {
      try {
        await Filesystem.stat({ path: filename, directory: Directory.Cache })
        const { uri } = await Filesystem.getUri({
          path: filename,
          directory: Directory.Cache,
        })
        return uri
      } catch {
        return null
      }
    },

    async probeRemote(url: string, timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
      try {
        const response = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(timeoutMs),
        })
        return response.ok
      } catch {
        return false
      }
    },

    async download({ url, filename }: { url: string; filename: string }): Promise<string> {
      await Filesystem.downloadFile({
        url,
        path: filename,
        directory: Directory.Cache,
        recursive: true,
      })
      const { uri } = await Filesystem.getUri({
        path: filename,
        directory: Directory.Cache,
      })
      return uri
    },
  }
}
