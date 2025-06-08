import { NotesService, TracksService } from '@lectorium/dal/index'
import { NotesStore } from './useNotesStore'

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
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load() {
    const notes = await notesService.getAll()

    for (const note of notes) {
      // TODO: Load all related tracks in one request
      const track = await tracksService.findOne({ _id: note.trackId })
      if (!track) { continue }
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