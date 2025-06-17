<template>
  <IonItem
    button
    detail
    lines="none"
    @click="open = true"
  >
    <div slot="start">
      👑
    </div>
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.subscription.title') }}</h2>
      <p>{{ $t('settings.subscription.description') }}</p>
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
import { onMounted, ref } from 'vue'
import { IonItem, IonLabel, IonAlert, alertController } from '@ionic/vue'
import { Purchases, PURCHASES_ERROR_CODE } from '@revenuecat/purchases-capacitor'
import { default as SubscriptionDialog, type SubscriptionPlan } from './SubscriptionDialog.vue'
import { useConfig } from '@shruti/mobile/features/app.config'
import { Capacitor } from '@capacitor/core'
import { useI18n } from 'vue-i18n'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const i18n = useI18n()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)
const subscriptionPlans = ref<SubscriptionPlan[]>([])
const isSubscribedAlertOpen = ref(false)

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

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function loadItems() {
  const offerings = await Purchases.getOfferings()
  if (offerings.current) {
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
}

async function subscribe(plan: SubscriptionPlan) {
  try {
    const offerings = await Purchases.getOfferings()
    const aPackage = offerings.current?.availablePackages
      .find((pkg) => pkg.identifier === plan.packageId)
    if (aPackage) {
      await Purchases.purchasePackage({ aPackage })
      config.subscriptionPlan.value = plan.packageId
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
  try {
    const customerInfo = await Purchases.restorePurchases()
    const offerings = await Purchases.getOfferings()
    const activeSubscriptions = customerInfo.customerInfo.activeSubscriptions

    if (customerInfo.customerInfo.activeSubscriptions.length > 0) {
      console.log(
        'Active subscriptions:', 
        customerInfo.customerInfo.activeSubscriptions
      )
      
      config.subscriptionPlan.value = offerings.current?.availablePackages
        .find((pkg) => pkg.product.identifier === activeSubscriptions[0])
        ?.identifier || ''

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