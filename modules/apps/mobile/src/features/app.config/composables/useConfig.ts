import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'
import { ENVIRONMENT } from '@lectorium/mobile/env'


export const useConfig = createGlobalState(() => {
  const appLanguage  = ref('??')
  const authToken    = ref(ENVIRONMENT.readonlyAuthToken)
  const apiUrl       = ref(ENVIRONMENT.apiUrl)
  const databaseUrl  = ref(ENVIRONMENT.databaseUrl)
  const bucketName   = ref(ENVIRONMENT.bucketName)
  const subscriptionPlan         = ref('')
  const showPlayerProgress       = ref(true)
  const showNotesTab             = ref(true)
  const highlightCurrentSentence = ref(true)
  const savedTracksFilter        = ref<any>({})

  return {
    appLanguage,
    apiUrl,
    databaseUrl,
    authToken,
    bucketName,
    subscriptionPlan,
    showPlayerProgress,
    showNotesTab,
    highlightCurrentSentence,
    savedTracksFilter
  }
})
