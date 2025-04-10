import { Capacitor } from "@capacitor/core"
import { useConfig } from "@/app"
import { Database } from "@lectorium/dal/persistence"

export function useDatabase() {
  const config = useConfig()
  const databaseUrl = config.databaseUrl.value
  const localAdapter = Capacitor.isNativePlatform() ? 'cordova-sqlite' : undefined

  return {
    local: {
      userData:    new Database({ name: 'data.db', adapter: localAdapter }),
      tracks:      new Database({ name: 'tracks.db', adapter: localAdapter }),
      transcripts: new Database({ name: 'transcripts.db', adapter: localAdapter }),
      dictionary:  new Database({ name: 'dictionary.db', adapter: localAdapter }),
      index:       new Database({ name: 'index.db', adapter: localAdapter })
    },
    remote: {
      tracks:      new Database({ name: databaseUrl + '/tracks' }),
      transcripts: new Database({ name: databaseUrl + '/transcripts' }),
      dictionary:  new Database({ name: databaseUrl + '/dictionary' }),
      index:       new Database({ name: databaseUrl + '/index' })
    }
  }
}