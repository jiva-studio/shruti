import { storeToRefs } from 'pinia'
import { useEventBus } from '@lectorium/mobile/core'
import { usePlayer } from '@blocks/app.player'
import { useTranscriptLoader, useTranscriptStore } from '@blocks/app.transcript'

export function setupTranscriptFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const eventBus = useEventBus()
  const transcriptStore = storeToRefs(useTranscriptStore())
  const transcriptLoader = useTranscriptLoader()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.transcriptLoad.subscribe(async (event) => {
    if (transcriptStore.isLoading.value) { return }
    await transcriptLoader.load(event.trackId) 
  })

  player.progress.subscribe(async (status) => {
    if (!status.trackId) { return }
    if (transcriptStore.isLoading.value) { return }
    if (transcriptStore.transcript.value.length > 0) { return }
    eventBus.transcriptLoad.notify({ trackId: status.trackId })
  })
}