import { useEventBus } from '@lectorium/mobile/core'
import { useAppStatus, useAppStatusStore } from '@blocks/app.status'
import { useAnalytics } from '@blocks/app.analytics'

export function setupAppStatusFeature() {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const eventBus = useEventBus()
  const appStatus = useAppStatus()
  const analytics = useAnalytics() 
  const appStatusStore = useAppStatusStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.appStatusCheck.subscribe(async () => {
    // Save server statuses before checking
    const serversOfflineBefore = isAnyServerOffline()

    // Check statuses of all servers
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

    // Check if overall status changed and update analytics if needed
    const serversOfflineAfter = isAnyServerOffline()
    if (!serversOfflineBefore && serversOfflineAfter) {
      analytics.track('app.status.offline', { 
        servers: appStatusStore.serverStatuses.map(s => s.name) 
      })
    }
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Private                                  */
  /* -------------------------------------------------------------------------- */

  function isAnyServerOffline() {
    return appStatusStore.serverStatuses.some(status => status.status === 'offline')
  }

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
