import { useEventBus } from '@lectorium/mobile/core'
import { useConfig } from '@blocks/app.config'
import { useSubscription } from '@blocks/app.purchases'

export async function setupSubscriptionFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const eventBus = useEventBus()
  const subscription = useSubscription()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  /* -------------------------- Restore Subscription -------------------------- */

  eventBus.subscriptionLoad.subscribe(async () => {
    const result = await subscription.restore(config.userEmail.value)
    config.subscriptionPlan.value = result || ''
  })
}