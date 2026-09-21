<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"
import StatusPill from "@lib/ui/chat/StatusPill.vue"

// The pill as chat wears it: the shared view plus this app's spinner.
defineProps<{
  statusLabel?: string
  researchQuestions?: readonly string[]
  researchSources?: ReadonlyMap<string, { readonly label: string }>
}>()
</script>

<template>
  <StatusPill
    :status-label="statusLabel"
    :research-questions="researchQuestions"
    :research-sources="researchSources"
  >
    <template #spinner><IonSpinner name="dots" aria-hidden="true" /></template>
  </StatusPill>
</template>
