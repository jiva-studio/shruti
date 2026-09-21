<script setup lang="ts">
import { computed, inject } from "vue"
import {
  DEFAULT_TRACK_META_CONFIG,
  TRACK_META_CONFIG_KEY,
  type TrackMetaConfig,
} from "./trackMetaFields.js"
import { buildMetaSegments } from "./metaSegments.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  references?: readonly string[]
  tags?: readonly string[]
  location?: string
  date?: string
  /** Pre-formatted audio length (e.g. "47:12") — the app layer owns the
   *  ms→label formatting so this stays a plain string field. */
  duration?: string
  /** Override the active config — used by the settings preview. Lists
   *  leave this unset and inherit the app-wide provided config. */
  config?: TrackMetaConfig
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const provided = inject(TRACK_META_CONFIG_KEY, null)

const activeConfig = computed<TrackMetaConfig>(
  () => props.config ?? provided?.value ?? DEFAULT_TRACK_META_CONFIG
)

const segments = computed(() =>
  buildMetaSegments(activeConfig.value, {
    references: props.references,
    tags: props.tags,
    location: props.location,
    date: props.date,
    duration: props.duration,
  })
)
</script>

<template>
  <p v-if="segments.length" class="details">
    <template v-for="(seg, i) in segments" :key="seg.key">
      <span v-if="i > 0" class="sep">·</span>
      <template v-if="seg.kind === 'reference'">
        <span class="reference">{{ seg.text }}</span>
        <span v-if="seg.extra" class="reference extra">+{{ seg.extra }}</span>
      </template>
      <span v-else class="text">{{ seg.text }}</span>
    </template>
  </p>
</template>

<style scoped>
/* One run of inline text rather than a flex row: a flex line can only be cut
   off at the edge, while a text line ends in an ellipsis. The fixed line
   height keeps a row with a reference exactly as tall as one without. */
.details {
  min-width: 0;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sep {
  margin: 0 4px;
  opacity: 0.5;
}

.reference {
  white-space: nowrap;
}

.reference.extra {
  opacity: 0.5;
}
</style>
