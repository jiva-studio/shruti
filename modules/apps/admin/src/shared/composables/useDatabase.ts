import { createSharedComposable } from '@vueuse/core'
import { Database } from '@lectorium/dal/persistence/Database'
import { useAuthTokens } from '@lectorium/admin/auth'
import { useConfig } from './useConfig'

export const useDatabase = createSharedComposable(() => {
  const config = useConfig()
  const authTokens = useAuthTokens()

  return {
    local: {
      tracks: new Database({ name: 'tracks' }),
      transcripts: new Database({ name: 'transcripts' }),
      dictionary: new Database({ name: 'dictionary' }),
      inbox: new Database({ name: 'inbox' }),
    },
    remote: {
      tracks: new Database({
        name: config.couchDbUrl + '/tracks',
        authToken: () => authTokens.value.accessToken,
      }),
      transcripts: new Database({
        name: config.couchDbUrl + '/transcripts',
        authToken: () => authTokens.value.accessToken,
      }),
      dictionary: new Database({
        name: config.couchDbUrl + '/dictionary',
        authToken: () => authTokens.value.accessToken,
      }),
      inbox: new Database({
        name: config.couchDbUrl + '/inbox',
        authToken: () => authTokens.value.accessToken,
      }),
    },
  }
})
