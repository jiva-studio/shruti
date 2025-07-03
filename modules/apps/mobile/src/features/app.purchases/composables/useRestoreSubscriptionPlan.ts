import { Purchases } from '@revenuecat/purchases-capacitor'
import { useConfig } from '@lectorium/mobile/features/app.config'
import { useLogger } from '@lectorium/mobile/features/app.core'

export function useRestoreSubscriptionPlan() {
  const config = useConfig()
  const logger = useLogger({ module: 'app.purchases' })

  async function restore() {
    try {
      if (!config.userEmail.value) { return }
      const result = await Purchases
        .logIn({ appUserID: config.userEmail.value })

      const activeEntitlements = Object.keys(result.customerInfo.entitlements.active)
      if (activeEntitlements.length === 0) {
        logger.info(`No active entitlements found for user: ${config.userEmail.value}`)
        config.subscriptionPlan.value = ''
        return
      }
      config.subscriptionPlan.value = activeEntitlements[0]
    } catch(error) {
      logger.error(`Unable to restore subscription: ${error}`)
    }
  }

  return { restore }
}