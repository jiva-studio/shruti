<template>
  <InputField id="author" label="Author" :errors="errors">
    <template #default="{ hasErrors }">
      <Select
        id="author"
        v-model="author"
        option-label="label"
        option-value="value"
        editable
        show-clear
        :options="authors"
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
  authors: { label: string; value: string }[]
}>()

const author = defineModel<string>('author', { default: '' })
</script>
