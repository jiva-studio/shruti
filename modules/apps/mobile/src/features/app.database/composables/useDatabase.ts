import { Capacitor } from '@capacitor/core'
import { Database } from '@lectorium/dal/persistence'
import { createSharedComposable } from '@vueuse/core'

type Options = {
  remoteDatabaseUrl: string
}

type Databases = {
  local: {
    index: Database,
    tracks: Database,
    userData: Database,
    dictionary: Database,
  },
  remote: {
    index: Database,
    tracks: Database,
    dictionary: Database,
  } 
}

export const useDatabase = createSharedComposable(() => {
  const adapter = Capacitor.isNativePlatform() ? 'cordova-sqlite' : undefined

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let databases: Databases | undefined = undefined

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function init({
    remoteDatabaseUrl 
  }: Options): Promise<void> {
    console.debug('Initializing database...')
    databases = {
      local: {
        userData: new Database({ 
          name: 'userData.db', 
          adapter: adapter, 
          indices: [
            // TODO: add archivedAt?
            { name: 'addedAt', fields: ['addedAt'] },
            // { name: 'type', fields: ['type'] },
            // { name: 'taskStatus', fields: [ 'taskStatus' ] },
            // { name: 'trackId', fields: ['trackId'] }
          ]
        }),
        tracks: new Database({
          name: 'tracks.db',
          adapter: adapter,
          indices: [
            { name: 'sort_reference', fields: ['sort_reference'] },
            { name: 'sort_date', fields: ['sort_date'] },
          ]
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
          name: remoteDatabaseUrl + '/tracks',
        }),
        dictionary: new Database({
          name: remoteDatabaseUrl + '/dictionary',
        }),
        index: new Database({
          name: remoteDatabaseUrl + '/index',
        }),
      },
    }

    await Promise.all([
      databases.local.dictionary.init(),
      databases.local.index.init(),
      databases.local.tracks.init(),
      databases.local.userData.init(),
    ])
  }

  function get(): Databases {
    if (!databases) {
      throw new Error('Database is not initialized. Call init() first.')
    }
    return databases
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get, init }
})
