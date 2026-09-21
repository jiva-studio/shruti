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
  /** Place in the collection being shown; omitted outside one. */
  position?: number
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

<template>
  <IonItem class="track" lines="none" button :detail="false" @click="$emit('select', trackId)">
    <slot name="state" :track-id="trackId" />

    <IonLabel class="ion-text-nowrap">
      <div class="lines">
        <span v-if="position" class="position">{{ position }}</span>
        <TrackHeader
          class="info"
          :title="title"
          :references="references"
          :tags="tags"
          :date="date"
          :config="config"
        />
        <p v-if="author" class="author">{{ author }}</p>
        <TrackMetaLine
          class="details"
          :references="references"
          :tags="tags"
          :location="location"
          :date="date"
          :duration="duration"
          :config="config"
        />
      </div>
    </IonLabel>
  </IonItem>
</template>

<style scoped>
.track,
.info,
.author,
.details {
  transition: all 1s ease;
}

/* One line box for all three, so the gaps between them are equal. They share
   one column so the number beside them indents the row as a whole. */
.info,
.author,
.details {
  grid-column: 2;
  margin: 0;
  line-height: 1.4;
}

/* The number is a gutter for the WHOLE row, not a chip on the title line:
   title, author and metadata all start at the same left edge, so a numbered
   row reads as one indented block instead of three ragged lines. The column
   is sized by the badge itself (`auto`), which keeps two- and three-digit
   places aligned without a magic width. Without a number the column collapses
   to nothing — the gap is the badge's own margin, not a `column-gap` that
   would still indent unnumbered rows. */
.lines {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
}

/* Same chip as the reference — same weight, size and stretch — so the two read
   as one family when a row carries both. Pinned width keeps single and double
   digits the same size; `align-self: center` against the title's grid row
   centres it on the title line exactly, with no hand-tuned offset. */
.position {
  grid-column: 1;
  grid-row: 1;
  align-self: center;
  margin-right: 5px;
  min-width: 1.6em;
  text-align: center;
  background-color: var(--ion-color-light-shade);
  font-weight: bold;
  color: var(--ion-color-medium);
  border-radius: 5px;
  padding: 0px 5px;
  font-size: 0.8em;
  font-stretch: condensed;
}

/* `ion-label` styles its DIRECT children via `::slotted(p)` — the grid wrapper
   above takes these two lines out of that reach, so the secondary typography it
   used to hand down is restored here verbatim. Without this the author and the
   metadata line silently jump to body size and full text colour. */
.author,
.details {
  font-size: 0.875rem;
}

.details {
  color: var(--ion-color-step-600);
}

.author {
  color: var(--ion-color-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Tighter rows; the divider between rows is a list-level <RowDivider>. */
.track {
  --min-height: 0;
}

.track ion-label {
  margin-top: 7px;
  margin-bottom: 7px;
}
</style>
