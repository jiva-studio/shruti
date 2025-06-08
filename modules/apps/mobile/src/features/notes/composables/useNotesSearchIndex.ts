import { NotesService } from '@lectorium/dal/index'
import { Note } from '@lectorium/dal/models'
import { ItemChangedEvent } from '@lectorium/dal/services/DatabaseService'
import { createSharedComposable } from '@vueuse/core'
import FlexSearch from 'flexsearch'

type Options = {
  notesService: NotesService
}

export const useNotesSearchIndex = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const index = new FlexSearch.Document({
    document: {
      id: '_id',
      store: true,
      index: [{
        field: 'text',
        tokenize: 'full',
        encoder: 'Normalize'
      }]
    }
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  async function init({ notesService }: Options) {
    // TODO: it might take long for big amount of notes.
    // FIX: use .import / .export methods to load baked search index 
    const items = await notesService.getAll({ limit: 1000 })
    for (const i of items) { index.add(i) }
    notesService.subscribe(onNotesChange)
  } 

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onNotesChange(event: ItemChangedEvent<Note>) {
    if (event.event === 'added') {
      index.add(event.item)
    } else if (event.event === 'updated') {
      index.update(event.item)
    } else if (event.event === 'removed') {
      index.remove(event.item._id)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function search(query: string) {
    const result = index.search({
      query, enrich: true, highlight: '<mark>$1</mark>'
    })

    return result
      .flatMap(sr => 
        sr.result.flatMap(
          i => ({
            id: i.id,
            field: sr.field!,
            highlight: i.highlight 
          })
        )
      )
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, search }
  
})