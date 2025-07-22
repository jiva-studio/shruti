import { App } from '@capacitor/app'
import { useBlockingFunction, useEventBus } from '@lectorium/mobile/core'
import { useSyncData, useSyncDataStorePersistenceTask } from '@blocks/app.sync.data'
import { useSyncMedia } from '@blocks/app.sync.media'
import { useTracksState } from '@blocks/app.tracks.state'
import { useDAL } from '@blocks/app.database'
import { useConfig } from '@blocks/app.config'

export async function setupSyncFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const eventBus = useEventBus()
  const syncData = useSyncData()
  const syncMedia = useSyncMedia()
  const tracksState = useTracksState()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.sync.subscribe(useBlockingFunction(async () => {
    // refresh token if required
    const isAuthTokenExpired =  Date.now() >= config.authTokenExpiresAt.value
    if (config.refreshToken.value && isAuthTokenExpired) {
      await eventBus.authTokenRefresh.notify({ refreshToken: config.refreshToken.value })
    }

    // sync data
    const syncResult = await syncData.sync()

    // download new media items for new tracks
    if (config.userId.value) {
      const result = await syncMedia.checkTracksWithoutMedia()
      result.newTrackIds.forEach(x => tracksState.store.setState(x, { downloadProgress: 0 }))
      if (result.newTrackIds.length > 0) {
        eventBus.trackDownload.notify({ trackIds: result.newTrackIds, skipFailed: true })
      }
      eventBus.playlistLoad.notify()
      eventBus.trackStateLoad.notify(['completed', 'inPlaylist'])
      // eventBus.userInfoLoad.notify()
    }

    // Invalidate caches
    dal.tags.invalidateCache()
    dal.authors.invalidateCache()
    dal.sources.invalidateCache()
    dal.locations.invalidateCache()
    dal.languages.invalidateCache()
    dal.durations.invalidateCache()
    dal.sortMethods.invalidateCache()

    // Notify sync end
    eventBus.syncEnd.notify(syncResult)
  }))

  dal.playlistItems.subscribe(async () => {
    eventBus.sync.notify()
  })

  dal.notes.subscribe(async () => { 
    eventBus.sync.notify()
  })

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) { eventBus.sync.notify() }
  })

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  await useSyncDataStorePersistenceTask().start()
}