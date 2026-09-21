<script setup lang="ts">
import { IonIcon, IonItem, IonLabel } from "@ionic/vue"
import { IconStarFilled } from "@tabler/icons-vue"
import { checkmarkCircle } from "ionicons/icons"

defineProps<{
  title: string
  /** Price line under the title — "then …" when the plan opens with a trial. */
  priceLine: string
  /** Empty when the plan carries no free trial. */
  trialBadge: string
  selected: boolean
  disabled: boolean
}>()

const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <IonItem
    :color="selected ? 'primary' : 'light'"
    :disabled="disabled"
    class="plan"
    lines="none"
    @click="emit('select')"
  >
    <IconStarFilled slot="start" :size="20" class="plan-icon" />
    <IonLabel>
      <h2>
        <b>{{ title }}</b>
        <span v-if="trialBadge" class="trial-badge">{{ trialBadge }}</span>
      </h2>
      <p>{{ priceLine }}</p>
    </IonLabel>
    <IonIcon v-if="selected" slot="end" :icon="checkmarkCircle" />
  </IonItem>
</template>

<style scoped>
.plan {
  margin: 0 0 6px;
  border-radius: 12px;
  --border-radius: 12px;
  --min-height: 42px;
  --padding-top: 2px;
  --padding-bottom: 2px;
  cursor: pointer;
}
.plan-icon {
  margin-inline-end: 10px;
  color: var(--ion-color-warning);
}
.plan h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 0.95rem;
}
.plan p {
  margin: 1px 0 0;
  font-size: 0.8rem;
}
.trial-badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.4;
  background: var(--ion-color-success, #2dd36f);
  color: var(--ion-color-success-contrast, #fff);
}
</style>
