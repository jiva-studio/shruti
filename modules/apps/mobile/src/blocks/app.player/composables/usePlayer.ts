import { Event } from '@shruti/mobile/core'
import { storeToRefs } from 'pinia'
import { AudioPlayer, Status } from '@shruti/audio-player'
import { Signal } from '@shruti/mobile/core'
import { usePlayerStore } from './usePlayerStore'
import { createSharedComposable } from '@vueuse/core'

type OpenRequest = {
  trackId: string
  playlistItemId: string
  url: string
  title: string
  author: string
}

export const usePlayer = createSharedComposable(() => { 

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const store = storeToRefs(usePlayerStore())
  const player = AudioPlayer

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  player.onProgressChanged((event) => {
    store.position.value = event.position
    store.duration.value = event.duration
    store.isPlaying.value = event.playing
    store.trackId.value = event.trackId || store.trackId.value
    progress.notify(event)
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Signals                                  */
  /* -------------------------------------------------------------------------- */

  async function open(request: OpenRequest) {
    await AudioPlayer.open({
      url: request.url,
      title: request.title,
      author: request.author,
      trackId: request.trackId,
    })

    store.trackId.value = request.trackId
    store.playlistItemId.value = request.playlistItemId
    store.title.value = request.title
    store.author.value = request.author
    store.isPlaying.value = false
    store.position.value = 0
    store.duration.value = 0

    return request
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

  return { open, play, seek, togglePause, progress, ...store }
})
