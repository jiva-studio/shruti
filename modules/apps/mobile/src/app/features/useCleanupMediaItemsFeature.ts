import { useDAL } from '@lectorium/mobile/app'

export function useCleanupMediaItemsFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async x => {
    if (x.event !== 'removed') { return }

    // TODO: it will return first page only
    // Get all media items related to 
    const mediaItems = await dal.mediaItems.getMany({
      selector: {
        trackId: x.item.trackId
      }
    })

    // Remove all media items
    await Promise.all(
      mediaItems.map(async x => await dal.mediaItems.removeOne(x._id))
    )
  })
}