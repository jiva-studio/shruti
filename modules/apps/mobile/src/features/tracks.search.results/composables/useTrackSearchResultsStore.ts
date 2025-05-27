import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { TrackSearchFilters } from '../models/TrackSearchFilters'
import { TrackSearchResultItem } from '../models/TrackSearchResultItem'

export const useTrackSearchResultsStore = defineStore('trackSearchResults', () =>{
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const items = reactive<Array<TrackSearchResultItem>>([])
  const filters = reactive<TrackSearchFilters>({})
  const isLoading = ref(false)
  const isLastPage = ref(false)
  const pagesLoaded = ref<number>(0)
  const maximumPagesToLoad = ref<number>(4)

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function setItems(
    value: TrackSearchResultItem[], 
    options? : { replace?: boolean }
  ) {
    if (options?.replace) { items.length = 0 }
    items.push(...value)
    isLastPage.value = value.length < 25
  }

  function loadNextPage() {
    if (pagesLoaded.value >= maximumPagesToLoad.value) { 
      isLastPage.value = true
      return
    }
    pagesLoaded.value += 1
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { 
    items, filters, setItems, isLastPage, isLoading, 
    pagesLoaded, loadNextPage, maximumPagesToLoad
  }
})