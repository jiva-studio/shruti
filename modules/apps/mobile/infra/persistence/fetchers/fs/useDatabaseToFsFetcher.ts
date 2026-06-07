import type { PluginListenerHandle } from "@capacitor/core"
import { Filesystem, Directory } from "@capacitor/filesystem"
import { MediaDownloader } from "@shruti/plugin-media-downloader"
import type { IDatabaseFetcher, ProgressCallback } from "@ports/app/index.js"

/**
 * `IDatabaseFetcher` for native platforms, backed by the
 * `@shruti/plugin-media-downloader` plugin for the actual transfer
 * (so it shares all the background-capable Android WorkManager / iOS
 * `URLSession.background` machinery with track audio downloads), plus
 * `@capacitor/filesystem` for the local exists/delete/list operations
 * that are pure on-disk lookups.
 *
 * Files land in `Directory.Data + <path>` — same path the SQLite plugin
 * resolves from, just expressed as a `DownloadDestination`.
 */
export function useDatabaseToFsFetcher(): IDatabaseFetcher {
  let isDownloading = false

  return {
    async download(url: string, path: string, onProgress?: ProgressCallback): Promise<void> {
      if (isDownloading) throw new Error("Download already in progress")
      isDownloading = true

      const trimmed = path.replace(/^\//, "")
      const lastSlash = trimmed.lastIndexOf("/")
      const subdir = lastSlash >= 0 ? trimmed.substring(0, lastSlash) : undefined
      const filename = lastSlash >= 0 ? trimmed.substring(lastSlash + 1) : trimmed

      const id = `db:${path}`
      const handles: PluginListenerHandle[] = []
      let onCompleted!: () => void
      let onFailed!: (error: Error) => void
      const completion = new Promise<void>((resolve, reject) => {
        onCompleted = resolve
        onFailed = reject
      })
      onProgress?.(0, 0, true)

      try {
        // Listeners must be attached BEFORE download(): a fast / cached
        // completion can fire its event synchronously, and a late listener
        // would miss it, hanging `completion` forever.
        if (onProgress) {
          handles.push(
            await MediaDownloader.addListener("progress", (e) => {
              if (e.id !== id) return
              onProgress(e.bytesDownloaded, e.contentLength, true)
            })
          )
        }
        handles.push(
          await MediaDownloader.addListener("completed", (e) => {
            if (e.id !== id) return
            onProgress?.(e.bytesDownloaded, e.bytesDownloaded, false)
            onCompleted()
          })
        )
        handles.push(
          await MediaDownloader.addListener("failed", (e) => {
            if (e.id !== id) return
            onFailed(new Error(e.error || "Database download failed"))
          })
        )

        await MediaDownloader.download({
          id,
          url,
          destination: { directory: "data", subdir, filename },
        })
        await completion
      } catch (err) {
        // A failed/partial DB download must not leave a truncated file on
        // disk: `findLocalDatabase`/`exists()` only check for presence, so a
        // half-written file would later be opened as a corrupt SQLite DB.
        // Drop both the final path and the plugin's `.download` temp.
        try {
          await Filesystem.deleteFile({ path, directory: Directory.Data })
        } catch {
          // Nothing partial on disk — fine.
        }
        try {
          await Filesystem.deleteFile({ path: `${path}.download`, directory: Directory.Data })
        } catch {
          // No temp neighbour — fine.
        }
        throw err
      } finally {
        for (const h of handles) await h.remove()
        isDownloading = false
      }
    },

    async exists(path: string): Promise<boolean> {
      try {
        await Filesystem.stat({ path, directory: Directory.Data })
        return true
      } catch {
        return false
      }
    },

    async delete(path: string): Promise<void> {
      try {
        await Filesystem.deleteFile({ path, directory: Directory.Data })
      } catch {
        // File doesn't exist — nothing to do.
      }
    },

    async list(directory: string): Promise<string[]> {
      try {
        const result = await Filesystem.readdir({ path: directory, directory: Directory.Data })
        return result.files.map((f) => `${directory}/${f.name}`)
      } catch {
        return []
      }
    },
  }
}
