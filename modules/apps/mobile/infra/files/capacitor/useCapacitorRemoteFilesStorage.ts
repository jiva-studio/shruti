import { Capacitor } from "@capacitor/core"
import { FileTransfer } from "@capacitor/file-transfer"
import { Filesystem, Directory } from "@capacitor/filesystem"
import type { IRemoteFilesStorage } from "@ports/app/index.js"

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
    // Directory already exists, ignore
  }
}

function urlToLocalPath(url: string, cacheDir: string): string {
  const urlObj = new URL(url)
  const pathname = urlObj.pathname.replace(/^\//, "")
  return `${cacheDir}/${pathname}`
}

export function useCapacitorRemoteFilesStorage({
  cacheDir,
}: {
  cacheDir: string
}): IRemoteFilesStorage {
  return {
    async get(url: string): Promise<string> {
      const localPath = urlToLocalPath(url, cacheDir)

      // Check if cached
      try {
        const { uri } = await Filesystem.getUri({
          path: localPath,
          directory: Directory.Cache,
        })
        await Filesystem.stat({ path: localPath, directory: Directory.Cache })
        return Capacitor.convertFileSrc(uri)
      } catch {
        // Not cached, download
      }

      // Download and cache
      await ensureDirectoryExists(localPath)

      const { uri: localUri } = await Filesystem.getUri({
        path: localPath,
        directory: Directory.Cache,
      })

      await FileTransfer.downloadFile({
        url,
        path: localUri,
      })

      return Capacitor.convertFileSrc(localUri)
    },

    async has(url: string): Promise<boolean> {
      const localPath = urlToLocalPath(url, cacheDir)
      try {
        await Filesystem.stat({ path: localPath, directory: Directory.Cache })
        return true
      } catch {
        return false
      }
    },

    async delete(url: string): Promise<void> {
      const localPath = urlToLocalPath(url, cacheDir)
      try {
        await Filesystem.deleteFile({ path: localPath, directory: Directory.Cache })
      } catch {
        // File doesn't exist, ignore
      }
    },

    async clearAll(): Promise<void> {
      try {
        await Filesystem.rmdir({ path: cacheDir, directory: Directory.Cache, recursive: true })
      } catch {
        // Directory doesn't exist or already cleared
      }
    },
  }
}
