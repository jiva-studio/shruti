import { ref } from 'vue'
import { defineStore } from 'pinia'


export const useSyncStore = defineStore('sync', () =>{

  const isSyncing = ref<boolean>(false)
  const lastSyncedAt = ref<number>(0)

  return { isSyncing, lastSyncedAt }
})