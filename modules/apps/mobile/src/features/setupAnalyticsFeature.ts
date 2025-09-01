import { watch } from 'vue'
import { App } from '@capacitor/app'
import { useEventBus } from '@shruti/mobile/core'
import { useAnalytics } from '@blocks/app.analytics'
import { useConfig } from '@blocks/app.config'
import { useDAL } from '@blocks/app.database'
import { useTranscriptStore } from '@blocks/app.transcript'

export function setupAnalyticsFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const eventBus = useEventBus()
  const analytics = useAnalytics()
  const transcriptStore = useTranscriptStore()

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  analytics.init(config.userId.value)

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignedIn.subscribe(async (event) => {
    analytics.setUserId(event.userId)
  }) 

  eventBus.authSignOut.subscribe(async () => {
    analytics.setUserId(undefined)
  })

  /* --------------------------------- Metrics -------------------------------- */
  
  dal.playlistItems.subscribe(async (e) => {
    if (e.event !== 'added') { return }
    analytics.track('app.playlist.trackAdded', { 
      trackId: e.item.trackId 
    }) 
  })

  dal.notes.subscribe(async (e) => {
    if (e.event !== 'added') { return }
    analytics.track('app.notes.noteAdded', {
      trackId: e.item.trackId,
      length: e.item.text.length,
    })
  })

  watch(() => transcriptStore.open, (v) => {
    if (!v) { return }
    analytics.track('app.player.transcript.open') 
  })

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) { analytics.track('app.open') }
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { analytics }
}