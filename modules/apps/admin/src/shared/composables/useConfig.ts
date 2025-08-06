import { createGlobalState } from '@vueuse/core'

export const useConfig = createGlobalState(() => {
  const origin = window.location.origin

  if (origin.includes('localhost')) {
    return {
      apiUrl: 'http://localhost:8101',
      couchDbUrl: 'http://localhost:5984',
    }
  } else {
    const apiUrl = origin.replace(/^https?:\/\/[^.]+\./, 'https://api.')
    const couchDbUrl = origin.replace(/^https?:\/\/[^.]+\./, 'https://couchdb.')
    return { apiUrl, couchDbUrl }
  }
})
