import { Capacitor } from '@capacitor/core'
import { useConfig } from '@/app'
import { Database } from '@lectorium/dal/persistence'

export function useDatabase() {
  const config = useConfig()
  const databaseUrl = config.databaseUrl.value
  const adapter = Capacitor.isNativePlatform() ? 'cordova-sqlite' : undefined

  return {
    local: {
      userData: new Database({ name: 'userData.db', adapter }),
      tracks: new Database({ name: 'tracks.db', adapter }),
      dictionary: new Database({ name: 'dictionary.db', adapter }),
      index: new Database({ name: 'index.db', adapter }),
    },
    remote: {
      tracks: new Database({
        name: databaseUrl + '/tracks',
      }),
      dictionary: new Database({
        name: databaseUrl + '/dictionary',
      }),
      index: new Database({
        name: databaseUrl + '/index',
      }),
    },
  }
}