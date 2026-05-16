import { Capacitor, type PluginListenerHandle } from "@capacitor/core"
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem"
import { MediaDownloader, type DownloadDestination } from "@shruti/plugin-media-downloader"
import type { IRemoteFilesStorage } from "@ports/app/index.js"

/**
 * `IRemoteFilesStorage` over the `@shruti/plugin-media-downloader`
 * plugin. Used for the "fetch on first access, then cache" flow that
 * powers transcripts and any other small remote assets the app needs to
 * read with `<img src>` / `fetch()` from the WebView.
 *
 * Two consumers — this and `useMediaDownloaderAdapter` (used for track
 * audio) — share the same `Directory.Cache + <cacheDir>/<URL.pathname>`
 * convention. That's what makes a file written by either side readable
 * by the other (e.g. you save a track for offline → audio is cached;
 * later we plan to also cache the track's transcript through here).
 *
 * `clearAll()` keeps using `Filesystem.rmdir` because the plugin's API
 * is intentionally per-file (`deleteFile(url)`); blowing the whole cache
 * is a filesystem operation, not a downloader concern.
 */
export function useCapacitorRemoteFilesStorage({
  cacheDir,
}: {
  cacheDir: string
}): IRemoteFilesStorage {
  function destinationFor(url: string): DownloadDestination {
    const path = new URL(url).pathname.replace(/^\//, "")
    const lastSlash = path.lastIndexOf("/")
    const subdir = lastSlash >= 0 ? `${cacheDir}/${path.substring(0, lastSlash)}` : cacheDir
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path
    return { directory: "cache", subdir, filename }
  }

  function idFor(url: string): string {
    return new URL(url).pathname
  }

  /** Wait for completion of one download identified by `id`. */
  function awaitCompletion(id: string): Promise<string> {
    const handles: PluginListenerHandle[] = []
    return new Promise<string>((resolve, reject) => {
      MediaDownloader.addListener("completed", (e) => {
        if (e.id !== id) return
        resolve(e.localUrl)
      }).then((h) => handles.push(h))
      MediaDownloader.addListener("failed", (e) => {
        if (e.id !== id) return
        reject(new Error(e.error || "Download failed"))
      }).then((h) => handles.push(h))
    }).finally(() => {
      for (const h of handles) void h.remove()
    })
  }

  return {
    async get(url: string): Promise<string> {
      const cached = await MediaDownloader.resolveLocalUrl({ url })
      if (cached.localUrl) return Capacitor.convertFileSrc(cached.localUrl)

      const id = idFor(url)
      const completion = awaitCompletion(id)
      await MediaDownloader.download({
        id,
        url,
        destination: destinationFor(url),
      })
      const localUrl = await completion
      return Capacitor.convertFileSrc(localUrl)
    },

    async getJson<T = unknown>(url: string): Promise<T> {
      // Ensure the file is cached locally, then read its bytes via the
      // Filesystem plugin. Going through `fetch(localUrl)` would work in
      // the WebView too but couples the caller to a particular runtime
      // capability; keep the IO inside the port.
      let { localUrl } = await MediaDownloader.resolveLocalUrl({ url })
      if (!localUrl) {
        const id = idFor(url)
        const completion = awaitCompletion(id)
        await MediaDownloader.download({
          id,
          url,
          destination: destinationFor(url),
        })
        localUrl = await completion
      }
      // `localUrl` is an absolute file:// path; `Filesystem.readFile`
      // accepts that form directly when no `directory` is supplied.
      const result = await Filesystem.readFile({
        path: localUrl,
        encoding: Encoding.UTF8,
      })
      const text = typeof result.data === "string" ? result.data : ""
      return JSON.parse(text) as T
    },

    async has(url: string): Promise<boolean> {
      const { localUrl } = await MediaDownloader.resolveLocalUrl({ url })
      return localUrl !== null
    },

    async delete(url: string): Promise<void> {
      await MediaDownloader.deleteFile({ url })
    },

    async clearAll(): Promise<void> {
      // Per-file deletion via the plugin would require an enumeration API
      // we don't expose; rmdir directly is simpler and matches what we did
      // before the migration.
      try {
        await Filesystem.rmdir({ path: cacheDir, directory: Directory.Cache, recursive: true })
      } catch {
        // Directory doesn't exist or already cleared.
      }
    },
  }
}
