import { FileTransfer } from "@capacitor/file-transfer"
import { Filesystem, Directory } from "@capacitor/filesystem"
import type { IDatabaseFetcher, ProgressCallback } from "@ports/app/index.js"

interface ProgressStatus {
  type: "download" | "upload"
  bytes: number
  contentLength: number
}

async function ensureDirectoryExists(path: string): Promise<void> {
  const dirPath = path.substring(0, path.lastIndexOf("/"))
  if (!dirPath) return
  try {
    await Filesystem.mkdir({
      path: dirPath,
      directory: Directory.Data,
      recursive: true,
    })
  } catch {
    // Directory already exists, ignore
  }
}

export function useDatabaseToFsFetcher(): IDatabaseFetcher {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let isDownloading = false
  let contentLength = 0

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    async download(url: string, path: string, onProgress?: ProgressCallback): Promise<void> {
      if (isDownloading) throw new Error("Download already in progress")

      isDownloading = true
      onProgress?.(0, 0, true)

      const listener = await FileTransfer.addListener("progress", (status: ProgressStatus) => {
        if (status.type !== "download") return
        contentLength = status.contentLength
        onProgress?.(status.bytes, status.contentLength, true)
      })

      try {
        await ensureDirectoryExists(path)

        const { uri: localUrl } = await Filesystem.getUri({
          path,
          directory: Directory.Data,
        })

        await FileTransfer.downloadFile({
          url,
          path: localUrl,
          progress: !!onProgress,
        })

        onProgress?.(contentLength, contentLength, false)
      } finally {
        await listener.remove()
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
