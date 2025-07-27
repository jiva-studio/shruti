import { Event, Signal } from '@shruti/mobile/core'
import { AudioPlayer, Status, type OpenParams } from '@shruti/audio-player'
import { createSharedComposable } from '@vueuse/core'

export const usePlayer = createSharedComposable(() => { 

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = AudioPlayer

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  player.onProgressChanged((event) => {
    progress.notify(event)
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Signals                                  */
  /* -------------------------------------------------------------------------- */

  async function open(request: OpenParams) {
    await player.open(request)
  }

  const play = new Signal(async () => {
    await player.play()
  })

  const seek = new Signal(async (position: number) => {
    await player.seek({ position })
  })

  const togglePause = new Signal(async () => {
    await player.togglePause()
  })

  const progress = new Event<Status>()

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { open, play, seek, togglePause, progress, close }
})
