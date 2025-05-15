<template>
  <IonModal
    :is-open="isOpen"
    @did-dismiss="isOpen = false"
  >
    <div class="content">
      <div>
        <h2>{{ $t('settings.subscription.choose') }}</h2>
        <p>{{ $t('settings.subscription.benefits.intro') }}</p>
        <div class="benefits">
          <IonList lines="none">
            <IonItem
              v-for="(index) in [1, 2, 3]"
              :key="index"
            >
              <IonIcon
                slot="start"
                :icon="checkmark"
              />
              <IonLabel>
                {{ $t(`settings.subscription.benefits.benefit${index}`) }}
              </IonLabel>
            </IonItem>
          </IonList>
        </div>
      </div>

      <div>
        <IonList lines="none">
          <IonItem
            v-for="plan in subscriptionPlans"
            :key="plan.packageId"
            class="plan"
            :color="selectedPlan?.packageId === plan.packageId ? 'primary' : 'light'"
            @click="selectPlan(plan)"
          >
            <IonLabel>
              <h2>{{ $t(`settings.subscription.plans.${plan.packageId}`) }}</h2>
              <p>
                {{ plan.price }} / 
                {{ $t(`settings.subscription.periods.${plan.billingPeriod}`) }}
              </p>
              <p>{{ plan.description }}</p>
            </IonLabel>
            <IonIcon
              v-if="selectedPlan?.packageId === plan.packageId"
              slot="end"
              :icon="checkmarkCircle"
            />
          </IonItem>
        </IonList>

        <IonButton
          expand="block"
          :disabled="!selectedPlan"
          class="subscribe-button"
          @click="subscribe"
        >
          {{ $t('settings.subscription.subscribe') }}
        </IonButton>

        <IonButton
          size="small"
          expand="block"
          color="medium"
          fill="clear"
          @click="isOpen = false"
        >
          {{ $t('app.cancel') }}
        </IonButton>
      </div>
    </div>
  </IonModal>
</template>

<script setup lang="ts">
import { IonModal, IonButton, IonList, IonItem, IonLabel, IonIcon } from '@ionic/vue'
import { checkmarkCircle, checkmark } from 'ionicons/icons'
import { ref, toRefs, watch } from 'vue'

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
.content {
  padding: 1rem;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.plan {
  border-radius: 8px;
  margin-bottom: 10px;
  transition: all 0.2s ease-in-out;
}

.subscribe-button {
  margin: 20px 0;
  --border-radius: 8px;
}

.benefits {
  margin-top: 20px;
  text-align: left;
}

.benefits h3 {
  font-size: 1.2rem;
  margin-bottom: 10px;
}
</style>
