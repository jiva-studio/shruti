import { Ref, watch } from 'vue'
import { useTranscriptLoader } from './useTranscriptLoader'
import { LanguagesService, NotesService, TracksService } from '@lectorium/dal/index'


type Options = {
  trackId: Ref<string>
  tracksService: TracksService
  languagesService: LanguagesService
  notesService: NotesService
}

export function useSyncTranscriptTask({
  trackId,
  tracksService,
  languagesService,
  notesService,
}: Options) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const transcriptLoader = useTranscriptLoader({ 
    tracksService, languagesService, notesService
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(trackId, async (v) => { await transcriptLoader.load(v) })
}