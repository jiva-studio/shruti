import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

/**
 * Predefined readonly user token for API requests.
 */
// TODO: inject another token for production build
const READONLY_USER_TOKEN = 
  '' +
  '' +
  '' +
  '' +
  '' +
  '' +
  ''

export const useConfig = createGlobalState(() => {
  const appLanguage  = ref('en')
  const databaseUrl  = ref('http://localhost:5984')
  const apiUrl       = ref('http://localhost:8001')
  const authToken    = ref(READONLY_USER_TOKEN)
  const bucketName   = ref('shruti-dev')

  return {
    appLanguage,
    apiUrl,
    databaseUrl,
    authToken,
    bucketName
  }
})
