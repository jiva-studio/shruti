import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useEventBus } from '@lectorium/mobile/core'
import { usePlayer } from '@blocks/app.player'
import { useTranscriptLoader, useTranscriptStore } from '@blocks/app.transcript'
import { useDAL } from '@blocks/app.database'
import { usePlayerStore } from '@blocks/app.player.state'

export function setupTranscriptFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const player = usePlayer()
  const eventBus = useEventBus()
  const playerStore = usePlayerStore()
  const transcriptStore = useTranscriptStore()
  const transcriptLoader = useTranscriptLoader()
  const { activeLanguages } = storeToRefs(transcriptStore)

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.transcriptLoad.subscribe(async (event) => {
    if (transcriptStore.isLoading) { return }
    await transcriptLoader.load(event.trackId, event.languages) 
  })

  player.progress.subscribe(async (status) => {
    if (!status.itemId) { return }
    if (transcriptStore.isLoading) { return }
    if (transcriptStore.transcript.length > 0) { return }

    const playlistItem = await dal.playlistItems.getOne(status.itemId)
    if (!playlistItem) { return }

    eventBus.transcriptLoad.notify({ trackId: playlistItem.trackId })
  })

  watch(activeLanguages, (value) => {
    eventBus.transcriptLoad.notify({ 
      trackId: playerStore.trackId,
      languages: value
    })
  })
}