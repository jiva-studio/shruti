import { Capacitor } from '@capacitor/core'
import { Purchases, LOG_LEVEL } from '@revenuecat/purchases-capacitor'
import { ENVIRONMENT } from '@lectorium/mobile/app/env'

export function useInAppPurchasesFeatures() {

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */
  
  async function init() {
    if (Capacitor.getPlatform() === 'web') {
      return
    }
    if (Capacitor.getPlatform() == 'ios') {
      return
    }
    if (!ENVIRONMENT.revenueCatKey) {
      return
    }

    await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG })
    await Purchases.configure({ apiKey: ENVIRONMENT.revenueCatKey })
    console.log('RevenueCat SDK configured!')
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init }
}