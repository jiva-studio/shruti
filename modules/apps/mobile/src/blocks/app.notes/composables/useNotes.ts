import { IRepository } from '@lectorium/dal/index'
import { createSharedComposable } from '@vueuse/core'
import { Note, Track } from '@lectorium/dal/models'
import { useNotesLoader } from './useNotesLoader'
import { useNotesStore } from './useNotesStore'

export type AddNoteRequest = {
  trackId: string,
  blocks: string[]
  text: string,
}

type InitOptions = {
  idGenerator: () => string
  notesRepository: IRepository<Note>
  tracksRepository: IRepository<Track>
}

export const useNotes = createSharedComposable(() => {
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: InitOptions | null = null

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const store = useNotesStore()

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: InitOptions) {
    options = o
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Adds a new note.
   * @param request - The request object containing note details
   */
  async function addNote(request: AddNoteRequest) {
    if (!options) {
      throw new Error('Notes feature is not initialized. Please call useNotes.init(options) first.')
    }
    options.notesRepository.addOne({
      _id: options.idGenerator(),
      type: 'note',
      trackId: request.trackId,
      text: request.text,
      blocks: request.blocks,
      createdAt: Date.now()
    })
  }

  async function load() {
    if (!options) { throw new Error('Notes feature is not initialized. Please call useNotes.init(options) first.') }
    const loader = useNotesLoader(options)
    store.items =  await loader.load()
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { addNote, init, load }
})