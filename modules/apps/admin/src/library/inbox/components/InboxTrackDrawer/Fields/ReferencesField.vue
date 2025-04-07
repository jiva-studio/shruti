<template>
  <InputField id="refs" label="References" :errors="errors">
    <template #default="{ hasErrors }">
      <AutoComplete
        id="refs"
        v-model="references"
        multiple
        :typeahead="false"
        :invalid="hasErrors"
      />
    </template>
  </InputField>
</template>

<script setup lang="ts">
import AutoComplete from 'primevue/autocomplete'
import { default as InputField, type Error } from './InputField.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  errors?: Error[]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const references = defineModel<string[]>('references', { default: () => [] })
</script>
