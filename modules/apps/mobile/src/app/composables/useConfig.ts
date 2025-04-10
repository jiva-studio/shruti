import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

export const useConfig = createGlobalState(() => {
  const databaseUrl  = ref("http://localhost:5984")

  return {
    databaseUrl,
  }
})
