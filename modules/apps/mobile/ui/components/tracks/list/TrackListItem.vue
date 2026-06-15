<template>
  <IonItem class="track" lines="none" button :detail="false" @click="$emit('select', trackId)">
    <slot name="state" :track-id="trackId" />

    <IonLabel class="ion-text-nowrap">
      <TrackHeader
        class="info"
        :title="title"
        :references="references"
        :tags="tags"
        :date="date"
        :config="config"
      />
      <TrackMetaLine
        class="details"
        :references="references"
        :tags="tags"
        :author="author"
        :location="location"
        :date="date"
        :duration="duration"
        :config="config"
      />
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel } from "@ionic/vue"
import TrackHeader from "./TrackHeader.vue"
import TrackMetaLine from "./TrackMetaLine.vue"
import type { TrackMetaConfig } from "./trackMetaFields.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

// Presentational only. Tap blocking + dim are owned by the outer
// wrapper (`PlaylistItems.vue` on Home; Search doesn't dim at all).
// Avoiding Ionic's `<IonItem :disabled>` here keeps the dim opacity
// consistent across states — Ionic's built-in disabled visuals would
// stack a ~0.5 multiplier on top of the wrapper's 0.65 label dim,
// making a downloading row visibly darker than a failed one.
defineProps<{
  trackId: string
  title: string
  references: readonly string[]
  tags: readonly string[]
  author?: string
  location?: string
  date?: string
  duration?: string
  /** Config override forwarded to the metadata line — only the settings
   *  preview sets it; lists inherit the app-wide provided config. */
  config?: TrackMetaConfig
}>()

defineEmits<{ select: [trackId: string] }>()
</script>

<style scoped>
.track,
.info,
.details {
  transition: all 1s ease;
}

/* Tighter rows with a soft divider that fades out at both ends (like the chat
   topic separator). */
.track {
  --min-height: 0;
  position: relative;
}

.track::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: linear-gradient(to right, transparent, rgba(0, 0, 0, 0.07), transparent);
  pointer-events: none;
}

.track ion-label {
  margin-top: 7px;
  margin-bottom: 7px;
}
</style>
