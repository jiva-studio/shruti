import { Database } from '@lectorium/dal/persistence'
import { createSharedComposable } from '@vueuse/core'

type InitOptions = {
  url: string,
  authToken: string,
  userId: string
}

type Databases = {
  tracks: Database,
  dictionary: Database,
  index: Database,
  userData?: Database
}

export const useRemoteDatabase = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let databases: Databases | undefined = undefined

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: InitOptions) {
    const userDataCollection = o.userId 
      ? 'users-' + o.userId.replace(/[^a-zA-Z0-9_]/g, '-') 
      : undefined

    const tracks = new Database({
      name: o.url + '/tracks',
    })
    const dictionary = new Database({
      name: o.url + '/dictionary',
    })
    const index = new Database({
      name: o.url + '/index',
    })
    const userData = userDataCollection ? new Database({
      name: o.url + '/' + userDataCollection,
      authToken: () => o.authToken
    }) : undefined

    databases = { tracks, dictionary, index, userData }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

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
