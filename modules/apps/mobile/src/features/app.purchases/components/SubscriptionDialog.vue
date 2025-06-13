<template>
  <IonModal
    :is-open="isOpen"
    @did-dismiss="isOpen = false"
  >
    <!-- Close Button -->
    <IonButton
      size="small"
      shape="round"
      class="close"
      color="medium"
      @click="isOpen = false"
    >
      <IonIcon
        slot="icon-only"
        :icon="close"
      />
    </IonButton>
    <Content>
      <!-- Header -->
      <SubscriptionHeader class="header" />

      <!-- Active Subscription -->
      <SubscriptionActive
        v-if="activePlan"
        package-id="studio.jiva.shruti"
        sku="pro"
      />
      
      <!-- Subscription Benefits -->
      <div 
        v-for="(index) in [0, 1, 2, 3, 4, 5]"
        :key="index"
      >
        <SubscriptionBenefit
          :icon="$t(`settings.subscription.benefits.benefit${index}.icon`)"
          :title="$t(`settings.subscription.benefits.benefit${index}.title`)"
          :description="$t(`settings.subscription.benefits.benefit${index}.description`)"
          :tag="index > 1 ? $t('app.soon') : undefined"
        />
      </div>

      <!-- Subscription Plans -->
      <template v-if="!activePlan && subscriptionPlans.length > 0">
        <SubscriptionPlanListItem 
          v-for="plan in subscriptionPlans"
          :key="plan.packageId"
          :title="$t(`settings.subscription.plans.${plan.packageId}`)"
          :price="plan.price"
          :period="$t(`settings.subscription.periods.${plan.billingPeriod}`)"
          :selected="selectedPlan?.packageId === plan.packageId"
          @click="selectPlan(plan)"
        />

        <IonButton
          expand="block"
          class="subscribe"
          :disabled="!selectedPlan"
          @click="subscribe"
        >
          {{ $t('settings.subscription.subscribe') }}
        </IonButton>
      </template>
 
      <!-- Legal Documents -->
      <IonNote class="legal">
        <a
          v-for="doc in legalDocuments"
          :key="doc.title"
          :href="doc.link"
        >
          {{ doc.title }}
        </a>
      </IonNote>
    </Content>
  </IonModal>
</template>

<script setup lang="ts">
import { IonModal, IonButton, IonNote, IonIcon } from '@ionic/vue'
import { close } from 'ionicons/icons'
import { ref, toRefs, watch } from 'vue'
import { Content } from '@shruti/mobile/features/app.core'
import SubscriptionActive from '../components/SubscriptionActive.vue'
import SubscriptionHeader from '../components/SubscriptionHeader.vue'
import SubscriptionBenefit from '../components/SubscriptionBenefit.vue'
import SubscriptionPlanListItem from '../components/SubscriptionPlanListItem.vue'

/* -------------------------------------------------------------------------- */
/*                                   Models                                   */
/* -------------------------------------------------------------------------- */

export type SubscriptionPlan = {
  packageId: string;
  name: string;
  price: string;
  billingPeriod: string;
  description: string;
}

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  subscriptionPlans: SubscriptionPlan[];
  activePlan?: string;
  legalDocuments: { title: string, link: string }[]
}>()

const emit = defineEmits<{
  (e: 'subscribe', plan: SubscriptionPlan): void;
}>()

const isOpen = defineModel<boolean>('open', { default: false })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { activePlan } = toRefs(props)

const selectedPlan = ref<SubscriptionPlan | undefined>()

const selectPlan = (plan: SubscriptionPlan) => {
  selectedPlan.value = plan
}

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(
  () => activePlan.value,
  (newValue) => {
    if (newValue) {
      selectedPlan.value = props.subscriptionPlans.find(plan => plan.packageId === newValue)
    }
  },
  { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

const subscribe = async () => {
  if (selectedPlan.value) {
    emit('subscribe', selectedPlan.value)
    isOpen.value = false
  }
}
</script>

<style scoped>
.subscribe {
  margin-top: 1.5rem;
  margin-bottom: 1rem;
  --box-shadow: none;
}

.legal {
  display: flex;
  justify-content: space-evenly;
  margin: 1rem;
}

.legal a {
  color: var(--ion-color-medium);
  text-decoration: none;
  font-size: .9rem;
}

.close {
  position: absolute;
  top: var(--ion-safe-area-top, 2rem);
  left: 10px;
  z-index: 999999;
}
</style>
