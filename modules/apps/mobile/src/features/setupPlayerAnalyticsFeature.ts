import { App } from '@capacitor/app'
import { useEventBus } from '@lectorium/mobile/core'
import { usePlayer } from '@blocks/app.player'
import { useAnalytics } from '@blocks/app.analytics'
import { usePlayerStore } from '@blocks/app.player.state'

export function setupPlayerAnalyticsFeature() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const playerStore = usePlayerStore()
  const eventBus = useEventBus()
  const analytics = useAnalytics()

  /* -------------------------------------------------------------------------- */
  /*                             Listening Session State                        */
  /* -------------------------------------------------------------------------- */

  let listeningStartPosition: number | null = null
  let isPlaying = false

  function endListeningSession(
    endPosition: number, 
    startPosition: number | null = null 
  ) {
    if (listeningStartPosition !== null && endPosition > listeningStartPosition) {
      const listeningTime = Math.floor(endPosition - listeningStartPosition)
      
      if (listeningTime <= 0) { return }

      analytics.track('app.listeningTime', {
        seconds: listeningTime,
      })
    }
    listeningStartPosition = startPosition
  }

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.playerSeek.subscribe(async (position) => {
    if (isPlaying) {
      endListeningSession(playerStore.position)
      listeningStartPosition = position 
    }
  })

  player.progress.subscribe(async (status) => {
    if (status.playing && !isPlaying) {
      // Resumed playback
      isPlaying = true
      listeningStartPosition = status.position
    } else if (!status.playing && isPlaying) {
      // Paused via status (fallback safety)
      isPlaying = false
      endListeningSession(status.position)
    }
  })

  App.addListener('appStateChange', (state) => {
    if (!state.isActive && isPlaying) {
      endListeningSession(playerStore.position, playerStore.position)
    }
  })
}