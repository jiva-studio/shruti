import { useNotesSearchIndex } from './useNotesSearchIndex'
import { NotesStore } from './useNotesStore'
import { watchDebounced } from '@vueuse/core'

type Options = {
  notesStore: NotesStore
}

export function useNotesSearchTask({
  notesStore
}: Options) {
  const notesSearchIndex = useNotesSearchIndex()

  watchDebounced(() => notesStore.searchQuery, async (value) => {
    // if (value.length <= 1) { return }

    const searchResults = await notesSearchIndex.search(value)
    notesStore.searchResults = searchResults.map(searchResult => ({
      ...notesStore.items.find(note => note.id === searchResult.id)!,
      [searchResult.field]: searchResult.highlight
    }))
  }) //, { debounce: 500, maxWait: 1000 })
  
}