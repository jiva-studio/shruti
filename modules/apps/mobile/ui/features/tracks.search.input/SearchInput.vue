<template>
  <IonSearchbar
    :model-value="modelValue"
    :placeholder="placeholder"
    :debounce="300"
    show-clear-button="focus"
    @ion-input="onInput"
  />
</template>

<script setup lang="ts">
import { IonSearchbar } from "@ionic/vue"

interface Props {
  modelValue: string
  placeholder?: string
}

withDefaults(defineProps<Props>(), { placeholder: "Search by title or reference" })
const emit = defineEmits<{ "update:modelValue": [value: string] }>()

function onInput(event: CustomEvent<{ value?: string | null }>): void {
  emit("update:modelValue", event.detail.value ?? "")
}
</script>
