<template>
  <InputField id="title" label="Topic of the Track" :errors="errors">
    <template #default="{ hasErrors }">
      <InputText id="title" v-model="title" size="large" :invalid="hasErrors" />
    </template>
  </InputField>
</template>

<script setup lang="ts">
import InputText from 'primevue/inputtext'
import { default as InputField, type Error } from './InputField.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  errors?: Error[]
}>()

const title = defineModel<string>('title', { default: '' })
</script>
