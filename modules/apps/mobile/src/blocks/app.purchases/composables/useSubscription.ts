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

  async function init(userId: string | null = null) {
    let revenueCatKey: string | undefined = undefined
    if (Capacitor.getPlatform() === 'web') { return }
    if (Capacitor.getPlatform() === 'android') { 
      revenueCatKey = ENVIRONMENT.revenueCatGoogleKey
    }
    if (Capacitor.getPlatform() === 'ios') { 
      revenueCatKey = ENVIRONMENT.revenueCatAppleKey
    }
    if (!revenueCatKey) { return }

    await Promise.all([
      Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG }),
      Purchases.configure({ 
        apiKey: revenueCatKey,
        appUserID: userId,
      })
    ])
    console.log('RevenueCat SDK configured!')
  }

  /* --------------------------------- Restore -------------------------------- */
  
  async function restore(userId: string) {
    try {
      if (!userId) { return }
      const result = await Purchases
        .logIn({ appUserID: userId })

      const activeEntitlements = Object.keys(result.customerInfo.entitlements.active)
      if (activeEntitlements.length === 0) {
        logger.info(`No active entitlements found for user: ${userId}`)
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