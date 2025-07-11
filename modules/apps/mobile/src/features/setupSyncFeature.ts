import { App } from '@capacitor/app'
import { useBlockingFunction, useEventBus } from '@lectorium/mobile/core'
import { useSyncData } from '@blocks/app.sync.data'
import { useSyncMedia } from '@blocks/app.sync.media'
import { useTracksState } from '@blocks/app.tracks.state'
import { useDAL } from '@blocks/app.database'
import { useConfig } from '@blocks/app.config'

export function setupSyncFeature() {
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
    const isAuthTokenExpired =  Date.now() > config.authTokenExpiresAt.value
    if (config.refreshToken.value && isAuthTokenExpired) {
      await eventBus.authTokenRefresh.notify()
    }

    // sync data
    await syncData.sync()

    // download new media items for new tracks
    if (config.userEmail.value) {
      const result = await syncMedia.checkTracksWithoutMedia()
      result.newTrackIds.forEach(x => tracksState.store.setState(x, { downloadProgress: 0 }))
      eventBus.trackDownload.notify({ trackId: result.newTrackIds })
      eventBus.playlistLoad.notify()
      eventBus.trackStateLoad.notify(['completed', 'inPlaylist'])
      eventBus.notesLoad.notify()
      eventBus.userInfoLoad.notify()
    }
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
}