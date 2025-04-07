<template>
  <InputField id="title" label="Date" :errors="errors">
    <template #default>
      <div class="flex flex-row gap-2">
        <InputNumber
          v-model="date[0]"
          :use-grouping="false"
          :min-fraction-digits="0"
          :max-fraction-digits="0"
          placeholder="Year"
          fluid
        />
        <InputNumber
          v-model="date[1]"
          :use-grouping="false"
          :min-fraction-digits="0"
          :max-fraction-digits="0"
          placeholder="Month"
          fluid
        />
        <InputNumber
          v-model="date[2]"
          :use-grouping="false"
          :min-fraction-digits="0"
          :max-fraction-digits="0"
          placeholder="Day"
          fluid
        />
      </div>
    </template>
  </InputField>
</template>

<script setup lang="ts">
import InputNumber from 'primevue/inputnumber'
import { default as InputField, type Error } from './InputField.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  errors?: Error[]
}>()

const date = defineModel<number[]>('date', {
  default: [undefined, undefined, undefined],
})
</script>
