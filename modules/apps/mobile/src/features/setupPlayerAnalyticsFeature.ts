import { useEventBus } from '@lectorium/mobile/core'
import { usePlayer } from '@blocks/app.player'
import { useAnalytics } from '@blocks/app.analytics'

export function setupPlayerAnalyticsFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const eventBus = useEventBus()
  const analytics = useAnalytics()

  /* -------------------------------------------------------------------------- */
  /*                             Listening Session State                        */
  /* -------------------------------------------------------------------------- */

  let listeningStartPosition: number | null = null
  let isPlaying = false

  function endListeningSession(endPosition: number) {
    if (listeningStartPosition !== null && endPosition > listeningStartPosition) {
      const listeningTime = Math.floor(endPosition - listeningStartPosition)
      
      if (listeningTime <= 0) { return }

      analytics.track('app.listeningTime', {
        seconds: listeningTime,
      })
    }
    listeningStartPosition = null
  }

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.playerSeek.subscribe(async (position) => {
    if (isPlaying) {
      endListeningSession(player.position.value)
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
}