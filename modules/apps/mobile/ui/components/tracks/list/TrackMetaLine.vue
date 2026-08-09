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

<script setup lang="ts">
import { computed, inject } from "vue"
import {
  DEFAULT_TRACK_META_CONFIG,
  TRACK_META_CONFIG_KEY,
  type TrackMetaConfig,
  type TrackMetaFieldKey,
} from "./trackMetaFields.js"

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

interface Segment {
  key: string
  kind: "reference" | "text"
  text: string
  extra: number
}

function segmentFor(field: TrackMetaFieldKey): Segment | null {
  if (field === "reference") {
    // The reference slot falls back to the first tag when a track has no
    // scripture reference — same rule the legacy title chip used.
    const refs = props.references ?? []
    const text = refs[0] ?? (props.tags ?? [])[0]
    if (!text) return null
    return { key: "reference", kind: "reference", text, extra: Math.max(0, refs.length - 1) }
  }
  const text = props[field]
  if (!text) return null
  return { key: field, kind: "text", text, extra: 0 }
}

const segments = computed<Segment[]>(() => {
  const { top, bottom } = activeConfig.value
  const out: Segment[] = []
  for (const { field, enabled } of bottom) {
    // Skip disabled fields and the one promoted to the top widget so the
    // same piece of info never appears twice.
    if (!enabled || field === top) continue
    const seg = segmentFor(field)
    if (seg) out.push(seg)
  }
  // Guaranteed minimum: every track has an audio length, so when none of
  // the chosen fields resolved for this track fall back to the duration
  // so the line is never blank.
  if (out.length === 0 && props.duration) {
    out.push({ key: "duration", kind: "text", text: props.duration, extra: 0 })
  }
  return out
})
</script>

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
