import { useDAL } from '@lectorium/mobile/features/app.database'

export function useCleanupMediaItemsFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async x => {
    const isRemoved = x.event === 'removed'
    const isArchived = x.item.archivedAt !== undefined
    if (isRemoved || isArchived) {
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
    }
  })
}