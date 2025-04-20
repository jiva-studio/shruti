import { createSharedComposable } from '@vueuse/core'
import { Database } from '@lectorium/dal/persistence/Database'
import { useAuthTokens } from '@lectorium/admin/auth'

export const useDatabase = createSharedComposable(() => {
  // TODO: add config
  // const schema = window.location.protocol;
  // const hostname = window.location.hostname;
  // const serverBaseUrl = `${schema}//${hostname}/database`
  const authTokens = useAuthTokens()
  const serverBaseUrl = 'http://localhost:5984/'

  return {
    local: {
      tracks: new Database({ name: 'tracks' }),
      transcripts: new Database({ name: 'transcripts' }),
      dictionary: new Database({ name: 'dictionary' }),
      inbox: new Database({ name: 'inbox' }),
    },
    remote: {
      tracks: new Database({
        name: serverBaseUrl + '/tracks',
        authToken: () => authTokens.value.accessToken,
      }),
      transcripts: new Database({
        name: serverBaseUrl + '/transcripts',
        authToken: () => authTokens.value.accessToken,
      }),
      dictionary: new Database({
        name: serverBaseUrl + '/dictionary',
        authToken: () => authTokens.value.accessToken,
      }),
      inbox: new Database({
        name: serverBaseUrl + '/inbox',
        authToken: () => authTokens.value.accessToken,
      }),
    },
  }
})
