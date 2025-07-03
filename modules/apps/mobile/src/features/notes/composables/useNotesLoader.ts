import { NotesService, TracksService } from '@lectorium/dal/index'
import { NotesStore } from './useNotesStore'
import { useLogger } from '../../app.core'

export type Options = {
  notesService: NotesService
  tracksService: TracksService
  notesStore: NotesStore
}

export function useNotesLoader({
  notesService,
  tracksService,
  notesStore,
}: Options) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'notes'})


  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load() {
    notesStore.items = []
    const notes = await notesService.getAll()

    for (const note of notes) {      
      // TODO: Load all related tracks in one request
      const track = await tracksService.findOne({ _id: note.trackId })
      if (!track) {
        logger.error(`Track not found for note ${note._id} with trackId ${note.trackId}`)
        continue
      }

      notesStore.items.push({
        id: note._id,
        trackId: note.trackId,
        text: note.text,
        blocks: note.blocks,
        trackAuthor: track.author,
        trackTitle: track.title['ru'], // TODO: lang
      })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { load }
}