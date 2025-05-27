import { useDAL } from '../features/app.database/composables/useDAL'
import { useLogger } from '../features/app.core/composables/useLogger'
import { useDownloaderService } from '../features/app.services.download/composables/useDownloaderService'
import { useSyncDownloadingStateTask, useSyncPlaylistStateTask, useTracksStateFeature } from '../features/tracks.state'

export async function initTrackStateFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const downloader = useDownloaderService()
  const logger = useLogger({ module: 'init:trackStateFeature' })

  /* -------------------------------------------------------------------------- */
  /*                                    Steps                                   */
  /* -------------------------------------------------------------------------- */

  logger.info('Initializing...')

  useSyncDownloadingStateTask({
    getTasks: () => downloader.tasks,
    subscribeTaskStatus: (callback) => { downloader.statusEvent.subscribe(callback) },
    subscribeTaskFailed: (callback) => { downloader.failedEvent.subscribe(callback) },
    subscribeTaskEnqueued: (callback) => { downloader.enqueuedEvent.subscribe(callback) },
  }).start()

  useSyncPlaylistStateTask({
    playlistItemService: dal.playlistItems
  }).start()

  await useTracksStateFeature().init({
    mediaItemsService: dal.mediaItems,
    playlistItemsService: dal.playlistItems,
  })
}