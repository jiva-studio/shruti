import { createGlobalState } from '@vueuse/core'

export const useConfig = createGlobalState(() => {
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8001'

  return {
    apiUrl,
  }
})
