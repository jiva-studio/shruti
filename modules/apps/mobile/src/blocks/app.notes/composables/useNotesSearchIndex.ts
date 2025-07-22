import { IRepository, ItemChangedEvent } from '@lectorium/dal/index'
import { Note } from '@lectorium/dal/models'
import { createSharedComposable } from '@vueuse/core'
import FlexSearch from 'flexsearch'

type Options = {
  notesRepo: IRepository<Note>
}

export const useNotesSearchIndex = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null

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

  async function init(o: Options): Promise<void> {
    options = o
    await reload()
    options.notesRepo.subscribe(onNotesChange)
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

  async function reload() {
    if (!options) { throw new Error('useNoteSearchIndex is not initialized') }
    // TODO: it might take long for big amount of notes.
    // FIX: use index.import / index.export methods to load baked search index 
    index.clear()
    const items = await options.notesRepo.getAll({ limit: 1000 })
    for (const i of items) { index.add(i) }
  }

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

  return { init, search, reload }
  
})