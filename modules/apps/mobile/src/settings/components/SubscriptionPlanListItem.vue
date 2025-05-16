<template>
  <IonItem
    :color="selected ? 'primary' : 'light'"
    class="plan"
    lines="none"
  >
    <div slot="start">
      ⭐️
    </div>
    <IonLabel>
      <h2>{{ title }}</h2>
      <p> {{ price }} / {{ period }}</p>
    </IonLabel>
    <IonIcon
      v-if="selected"
      slot="end"
      :icon="checkmarkCircle"
    />
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel, IonIcon } from '@ionic/vue'
import { checkmarkCircle } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  title: string
  price: string
  period: string
  selected: boolean
}>()
</script>


<style scoped>
.plan {
  border-radius: 8px;
  margin-bottom: 10px;
  transition: all 0.5s ease-in-out;
}
</style>