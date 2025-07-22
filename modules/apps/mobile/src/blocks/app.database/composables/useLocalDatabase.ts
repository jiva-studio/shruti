import { Capacitor } from '@capacitor/core'
import { Database } from '@lectorium/dal/persistence'
import { createSharedComposable } from '@vueuse/core'

type Databases = {
  index: Database,
  tracks: Database,
  userData: Database,
  dictionary: Database,
}

export const useLocalDatabase = createSharedComposable(() => {
  const adapter = Capacitor.isNativePlatform() ? 'cordova-sqlite' : undefined

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let databases: Databases | undefined = undefined

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  async function init() {
    console.debug('Initializing database...')

    const userData = new Database({ 
      name: 'userData.db', 
      adapter: adapter, 
      indices: [
        // TODO: add archivedAt?
        { name: 'addedAt', fields: ['addedAt'] },
        // { name: 'type', fields: ['type'] },
        // { name: 'taskStatus', fields: [ 'taskStatus' ] },
        // { name: 'trackId', fields: ['trackId'] }
        { 
          name: 'createdAt', 
          fields: ['createdAt'],
          partial_filter_selector: { type: { $eq: 'note' } }
        }
      ]
    })
    const tracks = new Database({
      name: 'tracks.db',
      adapter: adapter,
      indices: [
        { name: 'sort_reference', fields: ['sort_reference'] },
        { name: 'sort_date', fields: ['sort_date'] },
      ]
    })
    const dictionary = new Database({
      name: 'dictionary.db',
      adapter: adapter,
      // indices: [
      //   { name: 'type', fields: ['type'] }
      // ]
    })
    const index = new Database({
      name: 'index.db',
      adapter: adapter
    })

    await Promise.all([
      dictionary.init(),
      index.init(),
      tracks.init(),
      userData.init(),
    ])

    databases = { tracks, dictionary, index, userData }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function get(): Databases {
    if (!databases) {
      throw new Error('Local Database is not initialized. Call init() first.')
    }
    return databases
  }

  async function destroyUserData() {
    if (!databases) { throw new Error('Local Database is not initialized. Call init() first.') }
    await databases.userData.destroy()
    await databases.userData.init()
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { get, init, destroyUserData }
})
