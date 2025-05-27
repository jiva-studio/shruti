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
  <SubscriptionDialog 
    v-model:open="open"
    :title="$t('settings.subscription.title')"
    :subscription-plans="subscriptionPlans"
    :active-plan="activePlan"
    @subscribe="subscribe"
  />
</template>


<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { IonItem, IonLabel } from '@ionic/vue'
import { Purchases } from '@revenuecat/purchases-capacitor'
import { default as SubscriptionDialog, type SubscriptionPlan } from './SubscriptionDialog.vue'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)
const subscriptionPlans = ref<SubscriptionPlan[]>([])
const activePlan = ref<string | undefined>(undefined)


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
  const customerInfo = await Purchases.getCustomerInfo()
  
  const activeSubscriptions = customerInfo.customerInfo.activeSubscriptions

  activePlan.value = offerings.current?.availablePackages
    .find((pkg) => pkg.product.identifier === activeSubscriptions[0])
    ?.identifier

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
  const offerings = await Purchases.getOfferings()
  const aPackage = offerings.current?.availablePackages
    .find((pkg) => pkg.identifier === plan.packageId)
  if (aPackage) {
    await Purchases.purchasePackage({ aPackage })
  }
}
</script>