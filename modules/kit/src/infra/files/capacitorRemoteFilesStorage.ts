import { Capacitor } from "@capacitor/core"
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem"
import { type IRemoteFilesStorage, urlToCacheKey } from "./remoteFilesStorage.js"

/**
 * Maps a remote URL to its on-disk cache path under `cacheDir`: the URL
 * pathname appended to the cache dir. Pure — no IO — so path derivation
 * is unit-testable and stays consistent between writes and lookups.
 */
export function cachePathFor(cacheDir: string, url: string): string {
  const relative = urlToCacheKey(url).replace(/^\//, "")
  return `${cacheDir}/${relative}`
}

/**
 * {@link IRemoteFilesStorage} backed by `@capacitor/filesystem`. Files
 * are fetched over the WebView (`fetch`) and written under
 * `Directory.Cache/<cacheDir>/<url-pathname>`; reads return a WebView-
 * usable URL via `Capacitor.convertFileSrc`. `getText` is served
 * stale-while-revalidate, mirroring the web adapter.
 *
 * Binary payloads are base64-encoded for `Filesystem.writeFile` (which
 * is text-oriented), then re-served from disk; JSON payloads are stored
 * and read as UTF-8 text.
 */
export function useCapacitorRemoteFilesStorage({
  cacheDir,
}: {
  cacheDir: string
}): IRemoteFilesStorage {
  async function exists(path: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path, directory: Directory.Cache })
      return true
    } catch {
      return false
    }
  }

  async function getUri(path: string): Promise<string> {
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
    return uri
  }

  async function writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    let binary = ""
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    await Filesystem.writeFile({
      path,
      directory: Directory.Cache,
      data: btoa(binary),
      recursive: true,
    })
  }

  async function writeText(path: string, text: string): Promise<void> {
    await Filesystem.writeFile({
      path,
      directory: Directory.Cache,
      data: text,
      encoding: Encoding.UTF8,
      recursive: true,
    })
  }

  return {
    async get(url: string): Promise<string> {
      const path = cachePathFor(cacheDir, url)
      if (!(await exists(path))) {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(
            `Remote file fetch failed: ${response.status} ${response.statusText} (${url})`
          )
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        await writeBinary(path, bytes)
      }
      return Capacitor.convertFileSrc(await getUri(path))
    },

    async getText(url: string, opts?: { validate?: (text: string) => void }): Promise<string> {
      const path = cachePathFor(cacheDir, url)
      if (await exists(path)) {
        // Stale-while-revalidate: refresh in the background, return the
        // cached body now. Offline is fine — keep the cached file.
        void (async () => {
          try {
            const fresh = await fetch(url, { cache: "no-store" })
            if (!fresh.ok) return
            const text = await fresh.text()
            // Reject a body that fails the caller's validator before caching.
            opts?.validate?.(text)
            await writeText(path, text)
          } catch {
            // Offline / invalid — leave the cached file in place.
          }
        })()
        const result = await Filesystem.readFile({
          path,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        })
        return typeof result.data === "string" ? result.data : ""
      }
      // First-ever fetch — block.
      const response = await fetch(url, { cache: "no-store" })
      if (!response.ok) {
        throw new Error(
          `Remote file fetch failed: ${response.status} ${response.statusText} (${url})`
        )
      }
      const text = await response.text()
      opts?.validate?.(text)
      await writeText(path, text)
      return text
    },

    async has(url: string): Promise<boolean> {
      return exists(cachePathFor(cacheDir, url))
    },

    async delete(url: string): Promise<void> {
      try {
        await Filesystem.deleteFile({
          path: cachePathFor(cacheDir, url),
          directory: Directory.Cache,
        })
      } catch {
        // Already gone — no-op.
      }
    },

    async clearAll(): Promise<void> {
      try {
        await Filesystem.rmdir({ path: cacheDir, directory: Directory.Cache, recursive: true })
      } catch {
        // Directory doesn't exist or already cleared.
      }
    },
  }
}
