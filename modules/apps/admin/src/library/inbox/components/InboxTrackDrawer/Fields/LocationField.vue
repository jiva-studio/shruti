<template>
  <InputField id="location" label="Location" :errors="errors">
    <template #default="{ hasErrors }">
      <Select
        id="location"
        v-model="location"
        option-label="label"
        option-value="value"
        editable
        show-clear
        :options="locations"
        :invalid="hasErrors"
      />
    </template>
  </InputField>
</template>

<script setup lang="ts">
import Select from 'primevue/select'
import { default as InputField, type Error } from './InputField.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  errors?: Error[]
  locations: { label: string; value: string }[]
}>()

const location = defineModel<string>('location', { default: '' })
</script>
