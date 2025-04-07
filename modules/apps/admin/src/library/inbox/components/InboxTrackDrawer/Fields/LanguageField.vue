<template>
  <InputField :id="id" :label="label" :errors="errors">
    <template #default="{ hasErrors }">
      <MultiSelect
        v-model="mvalue"
        display="chip"
        option-label="name"
        placeholder="Language"
        :options="languages"
        :max-selected-labels="5"
        :invalid="hasErrors"
        :show-toggle-all="false"
      />
    </template>
  </InputField>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import MultiSelect from 'primevue/multiselect'
import { default as InputField, type Error } from './InputField.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  id: string
  label: string
  errors?: Error[]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const languages = ref([
  { name: 'English', code: 'en' },
  { name: 'Russian', code: 'ru' },
  { name: 'Serbian', code: 'sr' },
])

const value = defineModel<string[]>('value', { default: () => [] })

const mvalue = computed({
  get: () => value.value.map((v) => languages.value.find((l) => l.code === v)),
  set: (val: string[]) => (value.value = val.map((x) => x.code)),
})
</script>
