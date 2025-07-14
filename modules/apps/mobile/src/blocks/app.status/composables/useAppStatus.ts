import { createSharedComposable } from '@vueuse/core'
import { ServerStatus, useAppStatusStore } from './useAppStatusStore'

type InitOptions = {
  servers: Omit<ServerStatus, 'status'>[]
}

export const useAppStatus = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const store = useAppStatusStore()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: InitOptions | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  const init = (initOptions: InitOptions) => {
    options = initOptions
    for (const server of options.servers) {
      store.serverStatuses.push({
        name: server.name,
        description: server.description,
        url: server.url,
        status: 'unknown',
      })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init }
})