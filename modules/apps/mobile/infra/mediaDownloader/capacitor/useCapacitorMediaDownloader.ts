import { FileTransfer } from "@capacitor/file-transfer"
import { Filesystem, Directory } from "@capacitor/filesystem"
import type { IMediaDownloader, ProgressCallback } from "@ports/app/index.js"

function urlToLocalPath(url: string, cacheDir: string): string {
  const urlObj = new URL(url)
  const pathname = urlObj.pathname.replace(/^\//, "")
  return `${cacheDir}/${pathname}`
}

async function ensureDirectoryExists(path: string): Promise<void> {
  const dirPath = path.substring(0, path.lastIndexOf("/"))
  if (!dirPath) return
  try {
    await Filesystem.mkdir({
      path: dirPath,
      directory: Directory.Cache,
      recursive: true,
    })
  } catch {
    // Directory already exists.
  }
}

/**
 * `IMediaDownloader` backed by `@capacitor/file-transfer` + `@capacitor/filesystem`.
 * Writes into the same `cacheDir` as `useCapacitorRemoteFilesStorage` so a
 * file downloaded here is transparently available to the play-flow reader
 * via `IRemoteFilesStorage.has()` / `.get()`.
 *
 * Progress reporting is wired from FileTransfer's `progress` event when the
 * caller supplies `onProgress`.
 */
export function useCapacitorMediaDownloader({ cacheDir }: { cacheDir: string }): IMediaDownloader {
  return {
    async download(url: string, onProgress?: ProgressCallback): Promise<string> {
      const localPath = urlToLocalPath(url, cacheDir)
      await ensureDirectoryExists(localPath)
      const { uri: localUri } = await Filesystem.getUri({
        path: localPath,
        directory: Directory.Cache,
      })

      let progressListener: { remove: () => Promise<void> } | null = null
      if (onProgress) {
        progressListener = await FileTransfer.addListener("progress", (event) => {
          if (event.type !== "download" || event.url !== url) return
          onProgress(event.bytes, event.contentLength, true)
        })
      }

      try {
        await FileTransfer.downloadFile({ url, path: localUri, progress: !!onProgress })
        if (onProgress) onProgress(1, 1, false)
      } finally {
        await progressListener?.remove()
      }

      // Raw file:// URI: ExoPlayer (and other native consumers) read it
      // directly. convertFileSrc() would yield http://localhost/_capacitor_file_/...
      // which only the WebView's request interceptor can resolve.
      return localUri
    },

    async delete(url: string): Promise<void> {
      const localPath = urlToLocalPath(url, cacheDir)
      try {
        await Filesystem.deleteFile({ path: localPath, directory: Directory.Cache })
      } catch {
        // File absent — treat as already-deleted.
      }
    },

    async resolveLocalUrl(url: string): Promise<string | null> {
      const localPath = urlToLocalPath(url, cacheDir)
      try {
        await Filesystem.stat({ path: localPath, directory: Directory.Cache })
        const { uri } = await Filesystem.getUri({ path: localPath, directory: Directory.Cache })
        return uri
      } catch {
        return null
      }
    },
  }
}
