import { Capacitor, type PluginListenerHandle } from "@capacitor/core"
import { Directory, Filesystem } from "@capacitor/filesystem"
import { MediaDownloader } from "@lectorium/plugin-media-downloader"
import type { IExcerptCache } from "@ports/app/excerptCache.js"

const DEFAULT_PROBE_TIMEOUT_MS = 1500

/**
 * `IExcerptCache` backed by `@capacitor/filesystem` for lookups +
 * `@lectorium/plugin-media-downloader` for the actual download.
 *
 * `findLocal` uses `stat → catch → null` because Capacitor's stat throws
 * on missing files rather than returning a flag.
 *
 * `download` delegates to `MediaDownloader` rather than
 * `Filesystem.downloadFile` (deprecated since v7.1.0 of
 * `@capacitor/filesystem`): the deprecated path runs on a legacy
 * `HttpURLConnection` impl that silently no-ops on a number of
 * Android-only edge cases and ignores `recursive: true`. The plugin's
 * native side (WorkManager + OkHttp on Android, `URLSession` on iOS)
 * `mkdirs()` the parent on Android, surfaces failures as a `failed`
 * event with a real error string, and returns a `file://`-prefixed
 * local URI ready for `@capacitor/share`.
 */
export function useCapacitorExcerptCache(): IExcerptCache {
  return {
    async findLocal(filename: string): Promise<string | null> {
      try {
        // A bare `stat` succeeds for a zero-byte / partially-written
        // leftover (e.g. an interrupted download), which would then be
        // served as a valid cache hit. Require a non-empty file so only
        // fully-written excerpts count as cached.
        const { size } = await Filesystem.stat({ path: filename, directory: Directory.Cache })
        if (!size) return null
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
      // Download atomicity: write to a temp sibling and atomically rename it
      // onto the canonical `filename` only once the download fully completes.
      // The native downloader streams bytes straight to its destination, so if
      // the process is killed / the download aborts mid-stream a partially
      // written multi-MB file is left at that path. Were that path `filename`,
      // `findLocal` (size > 0) would happily serve the torn file as a valid
      // cache hit. By downloading to `${filename}.tmp` and renaming only on
      // `completed`, the canonical `filename` can never be a partial — the
      // rename is the single atomic publish step. The `size > 0` guard in
      // `findLocal` then remains only as a cheap secondary defence.
      const tmpFilename = `${filename}.tmp`

      // `id = tmpFilename` keys the download for `completed`/`failed` event
      // matching. Excerpt filenames are slashless (`share-*-note-{id}.{mp3,mp4}`)
      // so they never collide with the tracks adapter's `id = URL.pathname`.
      const id = tmpFilename
      const handles: PluginListenerHandle[] = []
      let onCompleted!: (localUrl: string) => void
      let onFailed!: (error: Error) => void
      const result = new Promise<string>((resolve, reject) => {
        onCompleted = resolve
        onFailed = reject
      })

      // Attach listeners BEFORE calling download(): an already-cached /
      // fast completion can fire `completed`/`failed` synchronously, and a
      // listener registered after that would never see it — leaving this
      // promise pending forever.
      handles.push(
        await MediaDownloader.addListener("completed", (e) => {
          if (e.id !== id) return
          onCompleted(e.localUrl)
        })
      )
      handles.push(
        await MediaDownloader.addListener("failed", (e) => {
          if (e.id !== id) return
          onFailed(new Error(e.error || "Download failed"))
        })
      )

      try {
        await MediaDownloader.download({
          id,
          // The temp name IS this file's identity: the excerpt is published to
          // its final path by hand once the transfer lands, so nothing ever
          // looks the download up again.
          fileKey: tmpFilename,
          url,
          destination: { directory: "cache", subdir: "", filename: tmpFilename },
        })
        // The download landed in full at the temp path; publish it atomically.
        await result
        await Filesystem.rename({
          from: tmpFilename,
          to: filename,
          directory: Directory.Cache,
        })
        const { uri } = await Filesystem.getUri({
          path: filename,
          directory: Directory.Cache,
        })
        return uri
      } catch (error) {
        // Best-effort cleanup so an aborted download / failed rename never
        // leaves a `.tmp` orphan behind to leak cache space.
        try {
          await Filesystem.deleteFile({ path: tmpFilename, directory: Directory.Cache })
        } catch {
          // Temp file was never created or already gone — nothing to clean.
        }
        throw error
      } finally {
        for (const h of handles) await h.remove()
      }
    },

    toLocalUrl(fileUri: string): string {
      // `convertFileSrc` maps `file:///…` to the local app-server URL the
      // WebView can fetch (`http(s)://localhost/_capacitor_file_/…`).
      // No-op for non-file inputs and on web.
      return Capacitor.convertFileSrc(fileUri)
    },
  }
}
