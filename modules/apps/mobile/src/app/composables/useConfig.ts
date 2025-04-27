import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'
import { ENVIRONMENT } from '@/app/env'


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
  const authToken    = ref(READONLY_USER_TOKEN)
  const apiUrl       = ref(ENVIRONMENT.apiUrl)
  const databaseUrl  = ref(ENVIRONMENT.databaseUrl)
  const bucketName   = ref(ENVIRONMENT.bucketName)

  return {
    appLanguage,
    apiUrl,
    databaseUrl,
    authToken,
    bucketName
  }
})
