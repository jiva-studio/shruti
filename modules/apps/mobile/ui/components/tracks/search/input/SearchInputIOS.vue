<template>
  <IonSearchbar
    v-model="searchQuery"
    show-cancel-button="focus"
    :placeholder="placeholder"
    :cancel-button-text="$t('app.cancel')"
    @ion-focus="emit('focusChange', true)"
    @ion-blur="emit('focusChange', false)"
  />
</template>

<script setup lang="ts">
import { IonSearchbar } from "@ionic/vue"

const searchQuery = defineModel<string>({ type: String, default: "" })

defineProps<{
  placeholder?: string
}>()

const emit = defineEmits<{
  focusChange: [focused: boolean]
}>()
</script>
