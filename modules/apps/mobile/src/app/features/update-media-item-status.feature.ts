import { App } from '@capacitor/app'
import { useDAL, useDownloaderService } from '..'

export async function initUpdateMediaItemStatusesOnAppStateChange() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const downloader = useDownloaderService()

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  App.addListener('appStateChange', async ({ isActive }) => {
    if (!isActive) { return }
    console.log('App is active, updating media items status...')
    await updateMediaItems()
  })

  updateMediaItems()

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function updateMediaItems() {
    // get all media items which state can be updated
    const mediaItems = await dal.mediaItems
      .getInState(['pending', 'running'])

    // get downloader task status for each media item
    // and update media item status if necessary
    for (const mediaItem of mediaItems) {
      // get downloader task status
      const taskStatus = await downloader.getStatus({
        taskId: mediaItem.taskId
      })

      // update media item status if necessary
      if (mediaItem.taskStatus !== taskStatus.status) {
        console.log(
          `Download ${mediaItem.taskId} completed with status: `+
          `${mediaItem.taskStatus} -> ${taskStatus.status}`)
        mediaItem.taskStatus = taskStatus.status
        await dal.mediaItems.updateOne(mediaItem._id, mediaItem)
      }
    }
  }
}