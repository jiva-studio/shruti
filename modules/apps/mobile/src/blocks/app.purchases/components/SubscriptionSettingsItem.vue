<template>
  <IonItem
    button
    detail
    lines="none"
    @click="onMenuItemClicked"
  >
    <div slot="start">
      👑
    </div>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.subscription.title') }}</h2>
      <p v-if="!config.subscriptionPlan.value">
        {{ $t('settings.subscription.description') }}
      </p>
      <p v-else>
        {{ 
          $t(
            'settings.subscription.yourSubscriptionPlanIs', 
            { plan: subscriptionPlanName }
          ) 
        }}
      </p>
    </IonLabel>
  </IonItem>
  
  <!-- Subscribed Alert -->
  <IonAlert
    :header="$t('settings.subscription.subscribed')"
    :message="$t('settings.subscription.thanks')"
    :is-open="isSubscribedAlertOpen"
    :buttons="['Ok']"
    @did-dismiss="isSubscribedAlertOpen = false"
  />

  <!-- Subscription Dialog with plans -->
  <SubscriptionDialog 
    v-model:open="open"
    :title="$t('settings.subscription.title')"
    :subscription-plans="subscriptionPlans"
    :active-plan="config.subscriptionPlan.value"
    :legal-documents="legalDocuments"
    @subscribe="subscribe"
    @restore="restore"
  />
</template>


<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { IonItem, IonLabel, IonAlert, alertController } from '@ionic/vue'
import { Purchases, PURCHASES_ERROR_CODE, PurchasesOfferings } from '@revenuecat/purchases-capacitor'
import { useConfig } from '@blocks/app.config'
import { Capacitor } from '@capacitor/core'
import { default as SubscriptionDialog, type SubscriptionPlan } from './SubscriptionDialog.vue'
import { useAnalytics } from '@blocks/app.analytics'
import { useEventBus } from '@shruti/mobile/core'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const i18n = useI18n()
const config = useConfig()
const eventBus = useEventBus()
const analytics = useAnalytics()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)
const subscriptionPlans = ref<SubscriptionPlan[]>([])
const subscriptionPlanName = computed(() => { 
  const plan = config.subscriptionPlan.value
  if (!plan) return ''
  return plan[0].toUpperCase() + plan.slice(1).toLowerCase()
})
const isSubscribedAlertOpen = ref(false)
let offerings: PurchasesOfferings | null = null

const legalDocuments = [
  { title: 'Privacy Policy', link: 'https://shruti.app/policy' },
]
if (Capacitor.getPlatform() === 'ios') {
  legalDocuments.push({ 
    title: 'Terms Of Use',
    link: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' 
  })
}


/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

onMounted(() => {
  loadItems()
})

function onMenuItemClicked() {
  open.value = true
  analytics.track('app.subscriptions.open')
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function loadItems() {
  offerings = await Purchases.getOfferings()
  if (!offerings.current) { return }
  subscriptionPlans.value = offerings.current.availablePackages.map((pkg) => {
    return {
      packageId: pkg.identifier,
      name: pkg.product.title,
      price: pkg.product.priceString,
      billingPeriod: pkg.product.subscriptionPeriod ?? '???',
      description: pkg.product.description,
    }
  })
}

async function subscribe(plan: SubscriptionPlan) {
  if (!offerings || !offerings.current) { return }
  try {
    const aPackage = offerings.current?.availablePackages
      .find((pkg) => pkg.identifier === plan.packageId)
    if (aPackage) {
      await Purchases.purchasePackage({ aPackage })
      eventBus.subscriptionLoad.notify()
      open.value = false
    }
  } catch (e: any) {
    console.error(`${e.message}: ${e.underlyingErrorMessage}`)

    if (e.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) {
      return
    }

    const alert = await alertController.create({
      header: i18n.t('settings.subscription.title'),
      message: 
        i18n.t('settings.subscription.error') + ' ' +
        `${e.message} ${e.underlyingErrorMessage || ''}`,
      buttons: [i18n.t('app.ok')],
    })
    await alert.present()
  }
}

async function restore() {
  if (!offerings) { return }
  try {
    await Purchases.restorePurchases()
    eventBus.subscriptionLoad.notify()

    if (config.subscriptionPlan.value) {
      const alert = await alertController.create({
        header: i18n.t('settings.subscription.title'),
        message: i18n.t('settings.subscription.restored'),
        buttons: [i18n.t('app.ok')],
      })
      await alert.present()
      open.value = false
    } else {
      const alert = await alertController.create({
        header: i18n.t('settings.subscription.title'),
        message: i18n.t('settings.subscription.noSubscriptionFound'),
        buttons: [i18n.t('app.ok')],
      })
      await alert.present()
    }
  } catch (e: any) {
    console.error('Error restoring purchases:', e)

    const alert = await alertController.create({
      header: i18n.t('settings.subscription.title'),
      message: 
        i18n.t('settings.subscription.error') + ' ' +
        `${e.message} ${e.underlyingErrorMessage || ''}`,
      buttons: [i18n.t('app.ok')],
    })
    await alert.present()
  }
}
</script>