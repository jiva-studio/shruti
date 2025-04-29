import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'
import { ENVIRONMENT } from '@/app/env'


export const useConfig = createGlobalState(() => {
  const appLanguage  = ref('ru')
  const authToken    = ref(ENVIRONMENT.readonlyAuthToken)
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
