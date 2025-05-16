<template>
  <IonModal
    :is-open="isOpen"
    @did-dismiss="isOpen = false"
  >
    <Content>
      <SubscriptionHeader />
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
          :tag="index !== 0 ? $t('app.soon') : undefined"
        />
      </div>

      <!-- Subscription Plans -->
      <template v-if="!activePlan">
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
     
      <!-- Back Button -->
      <IonButton
        size="small"
        expand="block"
        color="medium"
        fill="clear"
        @click="isOpen = false"
      >
        {{ $t('app.back') }}
      </IonButton>
    </Content>
  </IonModal>
</template>

<script setup lang="ts">
import { IonModal, IonButton } from '@ionic/vue'
import { ref, toRefs, watch } from 'vue'
import Content from '@shruti/mobile/app/components/Content.vue'
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
</style>
