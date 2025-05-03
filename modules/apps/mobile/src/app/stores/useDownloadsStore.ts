import { defineStore } from 'pinia'
import { reactive } from 'vue'

export type DownloadTask = {
  mediaItemId: string
  trackId: string
  taskId: string
  progress: number
  state: 'successful' | 'pending' | 'paused' | 'failed' | 'running'
}

export const useDownloadsStore = defineStore('downloads', () => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const items = reactive<Record<string, DownloadTask>>({}) 
  
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function add(item: DownloadTask) {
    items[item.mediaItemId] = item
  }

  function remove(mediaItemId: string) {
    delete items[mediaItemId]
  }

  function update(mediaItemId: string, item: Partial<DownloadTask>) {
    if (!items[mediaItemId]) { return }
    items[mediaItemId] = { ...items[mediaItemId], ...item }
  }

  function count() {
    return Object.keys(items).length
  }

  function all() {
    return Object.values(items)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { items, add, update, remove, count, all }
})

