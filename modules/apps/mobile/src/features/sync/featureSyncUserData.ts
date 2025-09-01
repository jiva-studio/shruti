import { useBlockingFunction, useEventBus } from '@shruti/mobile/core'
import { useSyncData } from '@blocks/app.sync.data'
import { useConfig } from '@blocks/app.config'

export async function featureSyncUserData() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const eventBus = useEventBus()
  const syncData = useSyncData()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.sync.subscribe(useBlockingFunction(async () => {
    const syncResult = await syncData.sync()
    const errorCodes = syncResult.userData.pull?.errors?.map(e => e.code) || []

    const refreshTokenRequired = 
      errorCodes.some(c => [401, 400].includes(c)) &&
      config.refreshToken.value != ''
    if (refreshTokenRequired) {
      eventBus.authTokenRefresh.notify({ 
        refreshToken: config.refreshToken.value 
      })
    }
    
    eventBus.syncComplete.notify(syncResult)
  }))
}