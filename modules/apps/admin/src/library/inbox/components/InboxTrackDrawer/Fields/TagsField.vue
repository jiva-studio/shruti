<template>
  <InputField id="tags" label="Tags">
    <template #default="{ hasErrors }">
      <MultiSelect
        v-model="mvalue"
        display="chip"
        option-label="label"
        placeholder="Tags"
        :options="items"
        :max-selected-labels="5"
        :invalid="hasErrors"
        :show-toggle-all="false"
      />
    </template>
  </InputField>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MultiSelect from 'primevue/multiselect'
import { default as InputField } from './InputField.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  items: { label: string; value: string }[]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const value = defineModel<string[]>('tags', { default: () => [] })

const mvalue = computed({
  get: () => value.value.map((v) => props.items.find((l) => l.value === v)),
  set: (val) => (value.value = val.map((x) => x?.value)),
})
</script>
