<template>
  <IonItem
    lines="none"
    @click="open = true"
  >
    <div
      slot="start"
      class="settings-item-icon"
    >
      <ClockIcon />
    </div>
    
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.notifications.daily.title') }}</h2>
      <p>{{ $t('settings.notifications.daily.description') }}</p>
    </IonLabel>

    <div
      v-if="value"
      class="button"
    >
      {{ pad(value[0], 2) }} : {{ pad(value[1], 2) }}
    </div>
  </IonItem>

  <TimePickerDialog
    v-model:open="open"
    :hours="value ? value[0] : 9"
    :minutes="value ? value[1] : 0"
    @select="onChange"
  />
</template>


<script setup lang="ts">
import { ref } from 'vue'
import { IonItem, IonLabel} from '@ionic/vue'
import TimePickerDialog from './TimePickerDialog.vue'
import ClockIcon from '../icons/ClockIcon.vue'

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)
const value = defineModel<[number, number] | undefined>('value', { default: undefined, required: true })

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onChange(hours: number, munutes: number) {
  value.value = [hours, munutes]
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function pad(num: number, size: number): string {
  return num.toString().padStart(size, '0')
}
</script>


<style scoped>
.button {
  background-color: var(--ion-color-light-shade);
  padding: .25rem .5rem;
  border-radius: 5px;
  font-size: .8rem;
}
</style>