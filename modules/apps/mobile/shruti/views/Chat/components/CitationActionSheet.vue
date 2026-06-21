<template>
  <IonActionSheet
    :is-open="open"
    :header="trackTitle"
    :buttons="actionSheetButtons"
    @did-dismiss="emit('update:open', false)"
  />
</template>

<script setup lang="ts">
import { IonActionSheet } from "@ionic/vue"
import { useCitationActions } from "../composables/useCitationActions.js"
import type { CitationCoords } from "../composables/useCitationMeta.js"

/**
 * Host-owned action sheet for the citation surfaces. A leaf CitationCard emits
 * `activate`; the host sets `coords` + `open` and renders this. Keeping the
 * sheet here (not inside the card) means a card can be reused as a pure,
 * non-interactive preview — e.g. the onboarding daily-wisdom screen, which
 * never mounts this, so tapping the card opens nothing.
 */
const props = defineProps<{
  open: boolean
  coords: CitationCoords | null
  /** Known transcript text for the active fragment, so a saved note keeps it. */
  snippetText?: string | null
}>()
const emit = defineEmits<{ "update:open": [boolean] }>()

const EMPTY: CitationCoords = { trackId: "", startMs: 0, endMs: 0 }
const { trackTitle, actionSheetButtons } = useCitationActions(() => props.coords ?? EMPTY, {
  snippetText: () => props.snippetText ?? null,
})
</script>
