import { createSharedComposable } from '@vueuse/core'
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