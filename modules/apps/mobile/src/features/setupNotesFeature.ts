import { useEventBus } from '@shruti/mobile/core'
import { useDAL } from '@blocks/app.database'
import { useNotes, useNotesSearchIndex, useNotesSearchTask, useNotesStore } from '@blocks/app.notes'

export async function setupNotesFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const notes = useNotes()
  const eventBus = useEventBus()
  const notesStore = useNotesStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.notes.subscribe(async () => {
    eventBus.notesLoad.notify()
  })

  eventBus.notesAdd.subscribe(async (request) => {
    await notes.addNote(request)
    eventBus.notesLoad.notify()
  })

  eventBus.notesLoad.subscribe(async () => {
    await notes.load()
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Setup                                   */
  /* -------------------------------------------------------------------------- */

  await useNotesSearchIndex().init({
    notesRepo: dal.notes
  })
  useNotesSearchTask({ notesStore })
}
