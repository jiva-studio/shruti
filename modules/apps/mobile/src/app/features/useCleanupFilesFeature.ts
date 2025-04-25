import { Filesystem, Directory } from '@capacitor/filesystem'
import { useDAL } from '@/app'

export function useCleanupFilesFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.mediaItems.subscribe(async x => {
    if (x.event !== 'removed') { return }

    await Filesystem.deleteFile({
      path: x.item.localPath,
      directory: Directory.External,
    })
  })
}