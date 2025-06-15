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
  />
</template>


<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { IonItem, IonLabel, IonAlert } from '@ionic/vue'
import { Purchases } from '@revenuecat/purchases-capacitor'
import { default as SubscriptionDialog, type SubscriptionPlan } from './SubscriptionDialog.vue'
import { useConfig } from '@shruti/mobile/features/app.config'
import { Capacitor } from '@capacitor/core'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()

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
  try {
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
  } catch {
    subscriptionPlans.value = [
      {
        packageId: '$rc_monthly',
        name: 'Индра',
        price: '$2.99',
        billingPeriod: 'P1M',
        description: ''
      },
      {
        packageId: '$rc_annual',
        name: 'Индра',
        price: '$19.99',
        billingPeriod: 'P1Y',
        description: ''
      }
    ]
  }
}

async function subscribe(plan: SubscriptionPlan) {
  const offerings = await Purchases.getOfferings()
  const aPackage = offerings.current?.availablePackages
    .find((pkg) => pkg.identifier === plan.packageId)
  if (aPackage) {
    await Purchases.purchasePackage({ aPackage })
    // Haptics.impact({ style: ImpactStyle.Medium })
    // confetti({
    //   particleCount: 100,
    //   spread: 70,
    //   origin: { y: 0.6 },
    // })
    // playSubscriptionCompleteSound()
    // isSubscribedAlertOpen.value = true
    config.subscriptionPlan.value = plan.packageId
  }
}
</script>