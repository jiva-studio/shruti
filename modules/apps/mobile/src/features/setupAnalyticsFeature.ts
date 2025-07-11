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

  analytics.init(config.userEmail.value)

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  // TODO: return it
  // eventBus.authSignIn.subscribe(async (results) => {
  //   if (!results) { return }
  //   analytics.setUserId(results.userEmail)
  // }) 

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