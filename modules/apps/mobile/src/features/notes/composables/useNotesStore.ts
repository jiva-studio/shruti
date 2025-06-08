import { reactive, computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { Note } from '../models'

export type NotesStore = ReturnType<typeof useNotesStore>

export const useNotesStore = defineStore('notes', () =>{

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const searchQuery = ref<string>('')

  const items = reactive<Array<Note>>([])
  const searchResults = reactive<Array<Note>>([])

  const getHighligtedBlockIds = (trackId: string) => computed(() => {
    return items
      .filter(x => x.trackId === trackId)
      .flatMap(x => x.blocks)
  })
  
  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { items, getHighligtedBlockIds, searchQuery, searchResults }
})