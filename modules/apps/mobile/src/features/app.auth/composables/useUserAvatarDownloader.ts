import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

export function useUserAvatarDownloader() {
  /**
   * Downloads an image from the given URL and saves it to the device's external storage.
   * @param imageUrl The URL of the image to download.
   * @returns The local file path of the downloaded image or null if the download failed.
   */
  async function download(imageUrl: string): Promise<string | null> { 
    if (!imageUrl) { return null }

    const result = await Filesystem.downloadFile({
      url: imageUrl,
      path: 'userAvatar.jpg',
      directory: Directory.External,
    })

    if (!result || !result.path) {
      return null
    }
    
    return Capacitor.convertFileSrc(result.path)
  }

  return { download }
}
