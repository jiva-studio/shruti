import { ref } from 'vue'
import { defineStore } from 'pinia'

export type SearchFilterItem = {
  id: string,
  title: string
}

export const useSearchFiltersDictionaryStore = defineStore('searchFiltersDictionary', () =>{
  
  /* ------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const authors = ref<SearchFilterItem[]>([])
  const sources = ref<SearchFilterItem[]>([])
  const locations = ref<SearchFilterItem[]>([])
  const languages = ref<SearchFilterItem[]>([])
  const durations = ref<SearchFilterItem[]>([])
  const sort = ref<SearchFilterItem[]>([])

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { 
    authors, 
    sources, 
    locations, 
    languages, 
    durations,
    sort,
  }
})