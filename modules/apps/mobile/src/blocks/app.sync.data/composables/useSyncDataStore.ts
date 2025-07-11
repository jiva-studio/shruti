import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useSyncDataStore = defineStore('syncData', () =>{
  const isSyncing = ref<boolean>(false)
  const lastSyncedAt = ref<number>(0)
  return { isSyncing, lastSyncedAt }
})