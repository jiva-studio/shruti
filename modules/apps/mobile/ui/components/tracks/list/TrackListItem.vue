<template>
  <IonItem
    class="track"
    :class="{ 'is-dimmed': dimmed }"
    lines="none"
    :disabled="disabled"
    button
    :detail="false"
    @click="$emit('select', trackId)"
  >
    <slot name="state" :track-id="trackId" />

    <IonLabel class="ion-text-nowrap">
      <TrackHeader class="info" :title="title" :references="references" :tags="tags" />
      <TrackDetails class="details" :author="author" :location="location" :date="date" />
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel } from "@ionic/vue"
import TrackDetails from "./TrackDetails.vue"
import TrackHeader from "./TrackHeader.vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  trackId: string
  title: string
  references: readonly string[]
  tags: readonly string[]
  author?: string
  location?: string
  date?: string
  disabled?: boolean
  /** Visual dim only (opacity on the label). Row stays tappable —
   *  used for failed/in-flight download rows so the user can retry. */
  dimmed?: boolean
}>()

defineEmits<{ select: [trackId: string] }>()
</script>

<style scoped>
.track,
.info,
.details {
  transition: all 1s ease;
}

/* Dim is scoped to ion-label so the state-indicator slot (red X /
   spinner / check) stays at full opacity — the indicator reads as the
   same vivid red whether the row is dim or not. Same trick the Home
   playlist wrapper uses; both rules target the same element with the
   same opacity, so they coexist harmlessly. */
.track.is-dimmed :deep(ion-label) {
  opacity: 0.65;
}
</style>
