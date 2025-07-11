import { reactive, computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { Note } from '../models'

export type NotesStore = ReturnType<typeof useNotesStore>

export const useNotesStore = defineStore('notes', () =>{

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const searchQuery = ref<string>('')
  const items = ref<Array<Note>>([])
  const searchResults = reactive<Array<Note>>([])
  const isEmpty = computed(() => items.value.length <= 0)

  const getHighligtedBlockIds = (trackId: string) => computed(() => {
    return items.value
      .filter(x => x.trackId === trackId)
      .flatMap(x => x.blocks)
  })
  
  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { items, getHighligtedBlockIds, searchQuery, searchResults, isEmpty }
})