import { Capacitor } from '@capacitor/core'
import { Purchases, LOG_LEVEL } from '@revenuecat/purchases-capacitor'
import { ENVIRONMENT } from '@lectorium/mobile/env'
import { useConfig } from '../../app.config'

export function useInAppPurchasesFeatures() {

  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */
  
  async function init() {
    if (Capacitor.getPlatform() === 'web') { return }
    if (!ENVIRONMENT.revenueCatKey) { return }

    await Promise.all([
      Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG }),
      Purchases.configure({ 
        apiKey: ENVIRONMENT.revenueCatKey,
        appUserID: config.userEmail.value || null,
      })
    ])
    console.log('RevenueCat SDK configured!')
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init }
}