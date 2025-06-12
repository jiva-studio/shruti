import { Purchases } from '@revenuecat/purchases-capacitor'
import { useConfig } from '@lectorium/mobile/features/app.config'
import { useLogger } from '@lectorium/mobile/features/app.core'

export function useRestoreSubscriptionPlan() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const logger = useLogger({ module: 'app.purchases' })

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function init() {
    try {
      const offerings = await Purchases.getOfferings()
      const customerInfo = await Purchases.getCustomerInfo()
      const activeSubscriptions = customerInfo.customerInfo.activeSubscriptions

      config.subscriptionPlan.value = offerings.current?.availablePackages
        .find((pkg) => pkg.product.identifier === activeSubscriptions[0])
        ?.identifier || ''
    } catch {
      logger.error('Unable to restore subscription plan')
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init }
}