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
    @subscribe="subscribe"
  />
</template>


<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { IonItem, IonLabel, IonAlert } from '@ionic/vue'
import { Purchases } from '@revenuecat/purchases-capacitor'
import confetti from 'canvas-confetti'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { useSound } from '@vueuse/sound'
import subscriptionCompleteSound from '../assets/subscribed.mp3'
import { default as SubscriptionDialog, type SubscriptionPlan } from './SubscriptionDialog.vue'
import { useConfig } from '@lectorium/mobile/features/app.config'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const { play: playSubscriptionCompleteSound } = useSound(subscriptionCompleteSound)
const config = useConfig()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)
const subscriptionPlans = ref<SubscriptionPlan[]>([])
const isSubscribedAlertOpen = ref(false)


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
  // TODO: execute only if purchased complete vvv
  Haptics.impact({ style: ImpactStyle.Medium })
  confetti({
    particleCount: 100,
    spread: 70,
    origin: { y: 0.6 },
  })
  playSubscriptionCompleteSound()
  isSubscribedAlertOpen.value = true
  config.subscriptionPlan.value = plan.packageId
  // ^^^

  const offerings = await Purchases.getOfferings()
  const aPackage = offerings.current?.availablePackages
    .find((pkg) => pkg.identifier === plan.packageId)
  if (aPackage) {
    await Purchases.purchasePackage({ aPackage })
  }
}
</script>