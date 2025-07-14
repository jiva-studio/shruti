import { useEventBus } from '@lectorium/mobile/core'
import { useAppStatus, useAppStatusStore } from '@blocks/app.status'

export function setupAppStatusFeature() {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const eventBus = useEventBus()
  const appStatus = useAppStatus()
  const appStatusStore = useAppStatusStore()  

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.appStatusCheck.subscribe(async () => {
    for (const { name, url } of appStatusStore.serverStatuses) {
      try {
        const response = await fetch(url)
        if (response.ok) {
          appStatusStore.setServerStatus(name, 'online')
        } else {
          appStatusStore.setServerStatus(name, 'offline')
        }
      } catch (error) {
        appStatusStore.setServerStatus(name, 'offline')
      }
    }
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Setup                                   */
  /* -------------------------------------------------------------------------- */

  setInterval(() => {
    eventBus.appStatusCheck.notify()
  }, 60000) // Check every minute

  appStatus.init({
    servers: [{ 
      name: 'shruti.app', 
      description: 'Main Server',
      url: 'https://api.shruti.app/status'
    }], 
  })
}
