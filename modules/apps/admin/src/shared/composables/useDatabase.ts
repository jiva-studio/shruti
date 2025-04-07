import { createSharedComposable } from '@vueuse/core'
import { Database } from '@lectorium/dal/persistence/Database'

export const useDatabase = createSharedComposable(() => {
  // TODO: add config
  // const schema = window.location.protocol;
  // const hostname = window.location.hostname;
  // const serverBaseUrl = `${schema}//${hostname}/database`
  const serverBaseUrl = 'http://localhost:5984/'

  return {
    local: {
      tracks: new Database({ name: 'library-tracks-v0001.db' }),
      transcripts: new Database({ name: 'library-transcripts-v0001.db' }),
      dictionary: new Database({ name: 'library-dictionary-v0001.db' }),
      index: new Database({ name: 'library-index-v0001.db' }),
      inboxTracks: new Database({ name: 'tracks-inbox.db' }),
    },
    remote: {
      tracks: new Database({ name: serverBaseUrl + '/library-tracks-v0001' }),
      transcripts: new Database({
        name: serverBaseUrl + '/library-transcripts-v0001',
      }),
      dictionary: new Database({ name: serverBaseUrl + '/dictionary' }),
      index: new Database({ name: serverBaseUrl + '/library-index-v0001' }),
      inboxTracks: new Database({ name: serverBaseUrl + '/tracks-inbox' }),
    },
  }
})
