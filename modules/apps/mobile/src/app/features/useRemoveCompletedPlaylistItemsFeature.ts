import { useDAL } from '@/app'

export function useRemoveCompletedPlaylistItemsFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async () => {
    // Get items that were completed more than 24 hours ago
    const oneDayInMs = 24 * 60 * 60 * 1000
    const date = Date.now() - oneDayInMs

    try {
      // Get old completed items
      const completedPlaylistItems = await dal.playlistItems.getMany({
        selector: {
          completedAt: { $lte: date }
        }
      })

      // Delete all completed items
      await Promise.all(
        completedPlaylistItems.map(async x => await dal.playlistItems.removeOne(x._id))
      )
    } catch(err) {
      console.error(JSON.stringify(err))

    }
  })
}