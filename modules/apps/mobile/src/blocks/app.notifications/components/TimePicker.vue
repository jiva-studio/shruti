<template>
  <IonDatetime 
    :value="value"
    minute-values="0,5,10,15,20,25,30,35,40,45,50,55"
    locale="ru-RU" 
    presentation="time" 
    size="cover"
    @ion-change="onChange"
  />
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { IonDatetime } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  hours: number,
  minutes: number,
}>()

const emit = defineEmits<{
  change: [number, number]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const off = new Date().getTimezoneOffset() * 60000
const value = ref<string>(
  new Date(new Date().setHours(props.hours, props.minutes, 0, 0) - off).toISOString()
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onChange(value: any) {
  const time = value.detail?.value.split('T')[1]
  const [h, m, _] = time.split(':')
  emit('change', parseInt(h), parseInt(m))
}
</script>
