import { createSharedComposable } from '@vueuse/core'
import { useNotesStore } from './useNotesStore'
import { useDAL } from '../../app.database'
import { useIdGenerator } from '../../app.core'

export type AddNoteRequest = {
  trackId: string,
  blocks: string[]
  text: string,
}

export const useNotesFeature = createSharedComposable(() => {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const notesStore = useNotesStore()
  const idGenerator = useIdGenerator()

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Adds a new note.
   * @param request - The request object containing note details
   */
  function addNote(request: AddNoteRequest) {
    const id = idGenerator.generateId(24)
    notesStore.items.push({
      id: id,
      trackId: request.trackId,
      text: request.text,
      blocks: request.blocks,
      trackAuthor: '',
      trackTitle: '',
    })
    dal.notes.addOne({
      _id: id,
      type: 'note',
      trackId: request.trackId,
      text: request.text,
      blocks: request.blocks,
      createdAt: Date.now()
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { addNote }
})