import { useEventBus } from '@lectorium/mobile/core'
import { usePlayer } from '@blocks/app.player'
import { useTranscriptLoader, useTranscriptStore } from '@blocks/app.transcript'
import { useDAL } from '@blocks/app.database'

export function setupTranscriptFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const player = usePlayer()
  const eventBus = useEventBus()
  const transcriptStore = useTranscriptStore()
  const transcriptLoader = useTranscriptLoader()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.transcriptLoad.subscribe(async (event) => {
    if (transcriptStore.isLoading) { return }
    await transcriptLoader.load(event.trackId) 
  })

  player.progress.subscribe(async (status) => {
    if (!status.itemId) { return }
    if (transcriptStore.isLoading) { return }
    if (transcriptStore.transcript.length > 0) { return }

    const playlistItem = await dal.playlistItems.getOne(status.itemId)
    if (!playlistItem) { return }

    eventBus.transcriptLoad.notify({ trackId: playlistItem.trackId })
  })
}