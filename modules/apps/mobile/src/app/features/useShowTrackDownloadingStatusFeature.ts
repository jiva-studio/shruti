import {
  DownloaderStatusEventArgs, DownloaderTaskCompletedEventArgs,
  DownloaderTaskEnqueuedEventArgs, DownloaderTaskFailedEventArgs,
  useDAL, useDownloaderService
} from '@lectorium/mobile/app'
import { MediaItem } from '@lectorium/dal/models'
import { useLogger } from '@lectorium/mobile/app/composables/useLogger'
import { useTrackStateStore } from '../stores'

/**
 * This feature is responsible for showing the downloading status of tracks
 * in the app. It listens to events from the downloader service and updates
 * the track state store accordingly.
 */
export function useShowTrackDownloadingStatusFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const trackStateStore = useTrackStateStore()
  const downloaderService = useDownloaderService()
  const logger = useLogger({ module: 'feature:track-downloading-status' })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  downloaderService.statusEvent.subscribe(onDownloaderStatus)
  downloaderService.enqueuedEvent.subscribe(onDownloaderTaskEnqueued)
  downloaderService.completedEvent.subscribe(onDownoaderTaskCompleted)
  downloaderService.failedEvent.subscribe(onDownloaderTaskFailed)

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * When a downloader task is enqueued, set the download progress to 0 to
   * indicate that the download has started. Also, set the download failed
   * status to undefined to indicate that the download has not failed yet.
   */
  function onDownloaderTaskEnqueued(
    event: DownloaderTaskEnqueuedEventArgs
  ) {
    if (!event.meta.trackId) { return }
    trackStateStore.setStatus(event.meta.trackId, {
      downloadProgress: 0,
      downloadFailed: undefined,
    })
  }

  /**
   * When a downloader task is in progress, set the download progress to the
   * minimum progress of all tasks related to the track. This is because
   * the downloader service can have multiple tasks for the same track, and
   * we want to show the overall progress of the track. 
   */
  function onDownloaderStatus(
    event: DownloaderStatusEventArgs
  ) {
    if (!event.meta.trackId) { return }

    const tasksRelatedToTrack = downloaderService.tasks
      .filter(x => x.meta.trackId === event.meta.trackId)
    const downloadProgress = Math.min(...tasksRelatedToTrack.map(x => x.progress))
    trackStateStore.setStatus(event.meta.trackId, { downloadProgress })
    logger.info(
      `Downloader task status: ${event.meta.trackId}: ${event.progress}`)
  }

  /**
   * When a downloader task is completed, set state of the media item to
   * ready. This indicates that the media item is ready to be played or
   * read (audio or transcription).
   */
  function onDownoaderTaskCompleted(
    event: DownloaderTaskCompletedEventArgs
  ) {
    if (!event.meta.mediaItemId) { return }
    dal.mediaItems.patchOne(event.meta.mediaItemId, { state: 'ready' })
    logger.info(
      `Downloader task completed: ${event.meta.mediaItemId}`)
  }

  /**
   * When a downloader task fails, set the download failed status, and
   * update the state of the media item to failed. This indicates that
   * the media item is not ready to be played or read (audio or 
   * transcription) and it should be retried. 
   */
  function onDownloaderTaskFailed(
    event: DownloaderTaskFailedEventArgs
  ) {
    if (!event.meta.mediaItemId) { return }
    trackStateStore.setStatus(event.meta.trackId, { downloadFailed: true })
    dal.mediaItems.patchOne(event.meta.mediaItemId, { state: 'failed' })
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function init() {
    const failedStates: MediaItem['state'][] = ['pending', 'failed']

    // Get all media items that are in the pending or in failed state
    // and set the download failed status to true for each track
    const failedMediaItems = await dal.mediaItems.getInState(failedStates)
    const failedTracks = failedMediaItems
      .map(track => track.trackId)
      .filter(id => id !== undefined)
    failedTracks.forEach(trackId => {
      trackStateStore.setStatus(trackId, { downloadFailed: true })
    })
    logger.info(
      `Failed tracks (${failedTracks.length}): `+
      `${JSON.stringify(new Set(failedTracks), null, 2)}. ` + 
      `Media items: ${JSON.stringify(failedMediaItems, null, 2)}.`)

    // Check all playlist items and set the download failed status
    // to true for each track that has no media items or has media items
    // in the failed state
    const playlistItems = await dal.playlistItems.getAll()
    for (const playlistItem of playlistItems) {
      const mediaItems = await dal.mediaItems.getMany({ 
        selector: { trackId: playlistItem.trackId } 
      })

      const mediaItemsEmpty = mediaItems.length === 0
      const mediaItemsFailed = mediaItems.some(
        x => failedStates.includes(x.state)
      )

      if (mediaItemsEmpty || mediaItemsFailed) {
        logger.info(
          `Failed track in playlist - ${playlistItem.trackId}: `+
          `media items ${mediaItemsEmpty ? 'empty' : 'failed'}`)
        trackStateStore.setStatus(playlistItem.trackId, { downloadFailed: true })
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init }
}