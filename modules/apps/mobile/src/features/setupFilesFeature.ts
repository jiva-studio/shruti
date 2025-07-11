import { Filesystem, Directory } from '@capacitor/filesystem'
import { useDAL } from '@blocks/app.database'

export function setupFilesFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */
  
  dal.mediaItems.subscribe(async x => {
    if (x.event !== 'removed') { return }

    try {
      await Filesystem.deleteFile({
        path: x.item.localPath,
        directory: Directory.External,
      })
    } catch (e) {
      console.error('Unable to delete file', JSON.stringify(e))
    }
  })
}