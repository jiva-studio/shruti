import { Capacitor } from '@capacitor/core'
import { useConfig } from '@/app'
import { Database } from '@lectorium/dal/persistence'

export function useDatabase() {
  const config = useConfig()
  const databaseUrl = config.databaseUrl.value
  const adapter = Capacitor.isNativePlatform() ? 'cordova-sqlite' : undefined

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */


  const database = {
    local: {
      userData: new Database({ 
        name: 'userData.db', 
        adapter: adapter, 
        indices: [
          { name: 'addedAt', fields: ['addedAt'] },
          // { name: 'type', fields: ['type'] },
          // { name: 'taskStatus', fields: [ 'taskStatus' ] },
          // { name: 'trackId', fields: ['trackId'] }
        ]
      }),
      tracks: new Database({
        name: 'tracks.db',
        adapter: adapter,
        // indices: [
        //   { name: 'type', fields: ['type'] }
        // ]
      }),
      dictionary: new Database({
        name: 'dictionary.db',
        adapter: adapter,
        // indices: [
        //   { name: 'type', fields: ['type'] }
        // ]
      }),
      index: new Database({
        name: 'index.db',
        adapter: adapter
      }),
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

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function init() {
    return await Promise.all([
      database.local.dictionary.init(),
      database.local.index.init(),
      database.local.tracks.init(),
      database.local.userData.init(),
    ])
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    local: database.local,
    remote: database.remote,
    init
  }
}
