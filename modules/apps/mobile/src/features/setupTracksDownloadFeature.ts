import { useAnalytics } from '@blocks/app.analytics'
import { useConfig } from '@blocks/app.config'
import { useLocalization } from '@blocks/app.localization'
import { useTrackMediaItems } from '@blocks/app.tracks.mediaItems'
import { useTrackMediaItemsDownloader } from '@blocks/app.tracks.mediaItems.downloader'
import { useTracksState } from '@blocks/app.tracks.state'
import { useEventBus, useLogger } from '@lectorium/mobile/core'

export function setupTracksDownloadFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const i18n = useLocalization()
  const config = useConfig()
  const logger = useLogger({ module: 'tracks.download' })
  const eventBus = useEventBus()
  const analytics = useAnalytics()
  const tracksState = useTracksState()
  const trackMediaItems = useTrackMediaItems()
  const trackMediaItemsDownloader = useTrackMediaItemsDownloader()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.trackDownload.subscribe(async (event) => {
    logger.info(`Track download requested: ${event.trackIds}`)

    // refresh token if required
    const isAuthTokenExpired =  Date.now() >= config.authTokenExpiresAt.value
    if (config.refreshToken.value && isAuthTokenExpired) {
      await eventBus.authTokenRefresh.notify({ refreshToken: config.refreshToken.value })
    }

    // Download each track
    for (const trackId of event.trackIds) {
      // Skip failed tracks if the option is set
      const currentTrackState = tracksState.store.getState(trackId)
      if (currentTrackState.isFailed && event.skipFailed) { 
        logger.info(`Track ${trackId} is in failed state, skipping download`)
        continue
      }

      // Check if the track is already being downloaded
      const downloadingTasks = trackMediaItemsDownloader.getTasksByTrackId(trackId)
      if (downloadingTasks.length > 0) { continue }

      // Start downloading the track
      try {
        // Create media items for the track and start downloading them
        // logger.info(`Creating media items for track: ${trackId}`)
        const mediaItems = await trackMediaItems.createMediaItems(trackId)
        if (mediaItems.length === 0) { continue }

        // Update track state to indicate that the download has started
        tracksState.store.setState(trackId, { 
          downloadProgress: 0, 
          isFailed: undefined 
        })

        // Enqueue media items for download
        // logger.info(`Enqueuing media items for download: ${mediaItems.length} items`)      
        for (const mediaItem of mediaItems) {
          trackMediaItemsDownloader.enqueue(mediaItem)
        }
      } catch (error: any) {
        logger.error(`Failed to download track`, error)
        analytics.track('track.download.failed', { 
          trackId, message: error?.message || 'Unknown error'
        })
        tracksState.store.setState(trackId, { 
          isFailed: true, 
          downloadProgress: undefined 
        })
        if (event.showError) {
          eventBus.toastShow.notify({
            message: i18n.global.t(`errors.downloadFailed`),
            color: 'danger',
            duration: 5000,
          })
        }
      }
    }
  })

  trackMediaItemsDownloader.status.subscribe(async (mediaItem) => {
    const relatedDownloads = trackMediaItemsDownloader.getTasksByTrackId(mediaItem.trackId)
    const downloadProgress = Math.min(...relatedDownloads.map(x => x.progress || 0))
    tracksState.store.setState(mediaItem.trackId, { downloadProgress })
  })

  trackMediaItemsDownloader.failed.subscribe(async (mediaItem) => {
    tracksState.store.setState(mediaItem.trackId, { isFailed: true, downloadProgress: undefined })
    analytics.track('track.download.failed', { trackId: mediaItem.trackId })
  })
}