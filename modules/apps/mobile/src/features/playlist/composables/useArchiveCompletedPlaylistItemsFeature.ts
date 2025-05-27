import { useDAL } from '@lectorium/mobile/features/app.database'

export function useArchiveCompletedPlaylistItemsFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async () => { await onArchive() })

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onArchive() {
    // Get items that were completed more than 24 hours ago
    const oneDayInMs = 24 * 60 * 60 * 1000
    const date = Date.now() - oneDayInMs

    // Get old completed items
    const completedPlaylistItems = await dal.playlistItems.getMany({
      selector: {
        completedAt: { $lte: date },
        archivedAt: { $exists: false }
      }
    })

    // Archive all completed items
    await Promise.all(
      completedPlaylistItems.map(async x => await dal.playlistItems.archiveOne(x._id))
    )
  }

}