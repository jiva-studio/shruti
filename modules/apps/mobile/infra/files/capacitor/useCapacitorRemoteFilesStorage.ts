import { Capacitor } from "@capacitor/core"
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem"
import { MediaDownloader, type DownloadDestination } from "@lectorium/plugin-media-downloader"
import { watchDownload } from "@infra/watchDownload.js"
import type { IRemoteFilesStorage } from "@ports/app/index.js"

/**
 * Names ending in one of these are a transfer that never finished: the
 * media-downloader plugin's temp (`<name>.download`) and `getText`'s
 * write-then-rename sibling (`<name>.tmp`). Neither is ever readable content.
 */
const PARTIAL_SUFFIXES = [".download", ".tmp"] as const

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
 * `clearAll()` walks `cacheDir` with `Filesystem` directly because the
 * plugin's API is intentionally per-file (`deleteFile(url)`); blowing the
 * offline store is a filesystem operation, not a downloader concern. It
 * clears cache and only cache — `keep` names the subdirectories that survive,
 * which is how the content database (a ~54 MB download that lives under the
 * same root) stops being collateral damage of "Clear cache" (#1630).
 */
export function useCapacitorRemoteFilesStorage({
  cacheDir,
  keep = [],
}: {
  cacheDir: string
  /** Top-level entries under `cacheDir` that `clearAll()` must not delete. */
  keep?: readonly string[]
}): IRemoteFilesStorage {
  const keepNames = new Set(keep)

  function destinationFor(url: string): DownloadDestination {
    const path = new URL(url).pathname.replace(/^\//, "")
    const lastSlash = path.lastIndexOf("/")
    const subdir = lastSlash >= 0 ? `${cacheDir}/${path.substring(0, lastSlash)}` : cacheDir
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path
    return { directory: "data", subdir, filename }
  }

  /**
   * The file's own name — its path, with no host. It doubles as the download
   * id here because this storage never races the same file across CDNs, so
   * one attempt per file is all there ever is.
   */
  function idFor(url: string): string {
    return new URL(url).pathname
  }

  /**
   * Reclaim the download leftovers inside a KEPT directory.
   *
   * `keep` spares `databases/` from "Clear cache" so a ~54 MB catalog isn't
   * collateral (#1630) — but it spared the junk beside it too. A transfer the
   * OS kills mid-flight leaves the plugin's `<name>.download` temp (and
   * `getText`'s `.tmp` sibling) behind: nothing in the kept subtree is ever
   * enumerated again, so those partials were unreclaimable short of an
   * uninstall (#1663). They are never a usable file — only a *finished*
   * transfer is — so "free up space" may take them.
   *
   * The one thing this can hit is a partial being written RIGHT NOW by a
   * background content refresh; that download then fails and the next launch
   * re-fetches it, which is the same outcome as the storage pressure the user
   * ran this action to relieve.
   */
  async function sweepPartials(dir: string): Promise<void> {
    const entries = await Filesystem.readdir({ path: dir, directory: Directory.Data })
      .then((r) => r.files)
      .catch(() => null)
    if (!entries) return

    for (const entry of entries) {
      if (entry.type === "directory" || !PARTIAL_SUFFIXES.some((s) => entry.name.endsWith(s))) {
        continue
      }
      try {
        await Filesystem.deleteFile({ path: `${dir}/${entry.name}`, directory: Directory.Data })
      } catch {
        // Already gone or locked — the rest of the sweep still runs.
      }
    }
  }

  return {
    async get(url: string): Promise<string> {
      const cached = await MediaDownloader.resolveLocalUrl({ fileKey: idFor(url) })
      if (cached.localUrl) return Capacitor.convertFileSrc(cached.localUrl)

      const id = idFor(url)
      const { completion, cleanup } = await watchDownload(id, { label: "Remote file download" })
      try {
        await MediaDownloader.download({
          id,
          fileKey: id,
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
      const cached = await MediaDownloader.resolveLocalUrl({ fileKey: idFor(url) })
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
      const { completion, cleanup } = await watchDownload(id, { label: "Remote file download" })
      let localUrl: string
      try {
        await MediaDownloader.download({
          id,
          fileKey: id,
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
      const { localUrl } = await MediaDownloader.resolveLocalUrl({ fileKey: idFor(url) })
      return localUrl !== null
    },

    async delete(url: string): Promise<void> {
      await MediaDownloader.deleteFile({ fileKey: idFor(url) })
    },

    async clearAll(): Promise<void> {
      // Per-file deletion via the plugin would require an enumeration API we
      // don't expose, so go through Filesystem. One level of readdir is enough
      // for the entries we delete outright: everything below a non-kept entry
      // goes with the recursive rmdir. A readdir failure means the root is
      // absent or already cleared.
      const entries = await Filesystem.readdir({ path: cacheDir, directory: Directory.Data })
        .then((r) => r.files)
        .catch(() => null)
      if (!entries) return

      for (const entry of entries) {
        const path = `${cacheDir}/${entry.name}`
        if (keepNames.has(entry.name)) {
          if (entry.type === "directory") await sweepPartials(path)
          continue
        }
        try {
          if (entry.type === "directory") {
            await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true })
          } else {
            await Filesystem.deleteFile({ path, directory: Directory.Data })
          }
        } catch {
          // Already gone or locked — the rest of the sweep still runs.
        }
      }
    },
  }
}
