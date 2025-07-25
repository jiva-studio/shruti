import { reactive, ref, computed } from 'vue'
import { defineStore } from 'pinia'

export type PlaylistStoreItem = {
  playlistItemId: string
  trackId: string
  tags: string[]
  date?: string
  title: string
  author?: string
  location?: string
  completedAt?: number
  references: string[]
}

export const usePlaylistStore = defineStore('playlist', () =>{
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const items = reactive<Array<PlaylistStoreItem>>([])
  const hasChanges = ref(false)

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  const isEmpty = computed(() => {
    return items.length === 0
  })

  function setItems(value: PlaylistStoreItem[]) {
    items.length = 0
    items.push(...value)
  }

  function getByTrackId(trackId: string) {
    return items.find(item => item.trackId === trackId)
  }

  function remove(playlistItemId: string) {
    const index = items.findIndex(item => item.playlistItemId === playlistItemId)
    if (index !== -1) {
      items.splice(index, 1)
    }
  }

  function updateByTrackId(
    trackId: string, 
    data: Partial<PlaylistStoreItem>
  ) {
    const item = getByTrackId(trackId)
    if (item) {
      Object.assign(item, data)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { items, setItems, getByTrackId, updateByTrackId, isEmpty, remove, hasChanges }
})