import { createGlobalState } from '@vueuse/core'

export const useConfig = createGlobalState(() => {
  const origin = window.location.origin
  const apiUrl = origin.replace(/^https?:\/\/[^.]+\./, 'https://api.')
  const couchDbUrl = origin.replace(/^https?:\/\/[^.]+\./, 'https://couchdb.')

  if (origin.includes('localhost')) {
    throw new Error('Should not be working on localhost')
  }

  return {
    apiUrl,
    couchDbUrl,
  }
})
