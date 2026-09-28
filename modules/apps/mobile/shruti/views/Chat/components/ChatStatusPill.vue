<script setup lang="ts">
import { computed } from "vue"
import { IonSpinner } from "@ionic/vue"
import type { ResearchSourceKind } from "@lib/contracts"
import StatusPill from "@lib/ui/chat/StatusPill.vue"

// The pill as chat wears it: the shared view plus this app's spinner.
const props = defineProps<{
  statusLabel?: string
  researchQuestions?: readonly string[]
  researchSources?: ReadonlyMap<
    string,
    { readonly sourceKind: ResearchSourceKind; readonly label: string }
  >
}>()

// The app has never shown commentary or media sources; the site does.
const SHOWN_KINDS: ReadonlySet<ResearchSourceKind> = new Set([
  "verse",
  "lecture_chunk",
  "library_doc",
])

const shownSources = computed(() => {
  if (!props.researchSources) return undefined
  return new Map([...props.researchSources].filter(([, s]) => SHOWN_KINDS.has(s.sourceKind)))
})
</script>

<template>
  <StatusPill
    :status-label="statusLabel"
    :research-questions="researchQuestions"
    :research-sources="shownSources"
  >
    <template #spinner><IonSpinner name="dots" aria-hidden="true" /></template>
  </StatusPill>
</template>
