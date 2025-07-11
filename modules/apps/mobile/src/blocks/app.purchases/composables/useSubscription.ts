import { Purchases, LOG_LEVEL } from '@revenuecat/purchases-capacitor'
import { Capacitor } from '@capacitor/core'
import { ENVIRONMENT } from '@lectorium/mobile/env'
import { useLogger } from '@lectorium/mobile/core'
import { createSharedComposable } from '@vueuse/core'

export const useSubscription = createSharedComposable(() => {
  const logger = useLogger({ module: 'app.purchases' })

  /* -------------------------------------------------------------------------- */
  /*                                  Acttions                                  */
  /* -------------------------------------------------------------------------- */

  /* ---------------------------------- Init ---------------------------------- */

  async function init(email: string | null = null) {
    if (Capacitor.getPlatform() === 'web') { return }
    if (!ENVIRONMENT.revenueCatKey) { return }

    await Promise.all([
      Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG }),
      Purchases.configure({ 
        apiKey: ENVIRONMENT.revenueCatKey,
        appUserID: email,
      })
    ])
    console.log('RevenueCat SDK configured!')
  }

  /* --------------------------------- Restore -------------------------------- */
  
  async function restore(email: string) {
    try {
      if (!email) { return }
      const result = await Purchases
        .logIn({ appUserID: email })

      const activeEntitlements = Object.keys(result.customerInfo.entitlements.active)
      if (activeEntitlements.length === 0) {
        logger.info(`No active entitlements found for user: ${email}`)
        return null
      }
      return activeEntitlements[0]
    } catch(error) {
      logger.error(`Unable to restore subscription: ${error}`)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, restore }
})