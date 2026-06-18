import { Capacitor, type PluginListenerHandle } from "@capacitor/core"
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem"
import { MediaDownloader, type DownloadDestination } from "@lectorium/plugin-media-downloader"
import type { IRemoteFilesStorage } from "@ports/app/index.js"

/**
 * `IRemoteFilesStorage` over the `@lectorium/plugin-media-downloader`
 * plugin. Used for the "fetch on first access, then cache" flow that
 * powers transcripts and any other small remote assets the app needs to
 * read with `<img src>` / `fetch()` from the WebView.
 *
 * Transcripts cached here are part of the user's "save for offline" set
 * (prefetched alongside track audio so the Transcript dialog renders with
 * no network), so they live in durable app storage — `Directory.Data`
 * (Android `filesDir`, iOS `NSDocumentDirectory`), the same `directory:
 * "data"` base `useMediaDownloaderAdapter` writes track audio to. Using
 * `Directory.Cache` here (the previous behaviour) let the OS reclaim
 * saved transcripts under storage pressure without an uninstall (#51).
 *
 * `clearAll()` uses `Filesystem.rmdir` against the same Data directory
 * because the plugin's API is intentionally per-file (`deleteFile(url)`);
 * blowing the whole offline store is a filesystem operation, not a
 * downloader concern.
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
    return { directory: "data", subdir, filename }
  }

  function idFor(url: string): string {
    return new URL(url).pathname
  }

  /**
   * Subscribe to completion of one download identified by `id`, returning
   * both the promise and a cleanup. Listeners are attached eagerly (the
   * `addListener` calls are awaited by the caller before `download()` runs)
   * so a fast / already-cached completion can't fire its event before the
   * handler is in place and strand the promise forever.
   */
  async function awaitCompletion(
    id: string
  ): Promise<{ completion: Promise<string>; cleanup: () => void }> {
    const handles: PluginListenerHandle[] = []
    let onCompleted!: (localUrl: string) => void
    let onFailed!: (error: Error) => void
    const completion = new Promise<string>((resolve, reject) => {
      onCompleted = resolve
      onFailed = reject
    })
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
    return {
      completion,
      cleanup: () => {
        for (const h of handles) void h.remove()
      },
    }
  }

  return {
    async get(url: string): Promise<string> {
      const cached = await MediaDownloader.resolveLocalUrl({ url })
      if (cached.localUrl) return Capacitor.convertFileSrc(cached.localUrl)

      const id = idFor(url)
      const { completion, cleanup } = await awaitCompletion(id)
      try {
        await MediaDownloader.download({
          id,
          url,
          destination: destinationFor(url),
        })
        const localUrl = await completion
        return Capacitor.convertFileSrc(localUrl)
      } finally {
        cleanup()
      }
    },

    async getText(url: string, opts?: { validate?: (text: string) => void }): Promise<string> {
      // Stale-while-revalidate. Mirrors `checkForUpdatesInBackground`
      // for the DB: read the cached file immediately (fast cold-start)
      // and refresh in the background so the NEXT cold-start sees the
      // new content. The refresh fetches over the WebView (`fetch`) and
      // overwrites the cached file with `Filesystem.writeFile` — one
      // atomic write, no MediaDownloader delete-then-redownload gap.
      const cached = await MediaDownloader.resolveLocalUrl({ url })
      if (cached.localUrl) {
        const localUrl = cached.localUrl
        void (async () => {
          try {
            const fresh = await fetch(url, { cache: "no-store" })
            if (!fresh.ok) return
            const text = await fresh.text()
            // Validate the fresh body before persisting it. A 200 HTML error
            // page (captive portal) is `ok` but would otherwise poison the
            // cache so every later read fails until `clearAll`. The caller's
            // validator (e.g. JSON.parse) throws here, aborting the refresh
            // and leaving the good cached file in place.
            opts?.validate?.(text)
            // Write to a sibling temp file and rename over the target so a
            // concurrent `readFile` of `localUrl` never sees a half-written
            // file (which would make a downstream parse throw on a torn read).
            const tmpPath = `${localUrl}.tmp`
            await Filesystem.writeFile({
              path: tmpPath,
              data: text,
              encoding: Encoding.UTF8,
            })
            try {
              await Filesystem.rename({ from: tmpPath, to: localUrl })
            } catch (renameError) {
              // The temp file was written but the atomic publish failed; drop
              // the `.tmp` sibling so it doesn't leak, then bubble up to leave
              // the existing cached file untouched.
              try {
                await Filesystem.deleteFile({ path: tmpPath })
              } catch {
                // Temp already gone — nothing to clean.
              }
              throw renameError
            }
          } catch {
            // Offline, invalid response, or write failure — leave the
            // cached file untouched.
          }
        })()
        const result = await Filesystem.readFile({
          path: localUrl,
          encoding: Encoding.UTF8,
        })
        return typeof result.data === "string" ? result.data : ""
      }
      // First-ever fetch — we have to block. Route through MediaDownloader
      // so the file lands at the canonical path other readers expect.
      const id = idFor(url)
      const { completion, cleanup } = await awaitCompletion(id)
      let localUrl: string
      try {
        await MediaDownloader.download({
          id,
          url,
          destination: destinationFor(url),
        })
        localUrl = await completion
      } finally {
        cleanup()
      }
      const result = await Filesystem.readFile({
        path: localUrl,
        encoding: Encoding.UTF8,
      })
      return typeof result.data === "string" ? result.data : ""
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
        await Filesystem.rmdir({ path: cacheDir, directory: Directory.Data, recursive: true })
      } catch {
        // Directory doesn't exist or already cleared.
      }
    },
  }
}
