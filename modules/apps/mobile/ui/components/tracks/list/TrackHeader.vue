<script setup lang="ts">
import { computed, inject } from "vue"
import {
  DEFAULT_TRACK_META_CONFIG,
  TRACK_META_CONFIG_KEY,
  type TrackMetaConfig,
} from "./trackMetaFields.js"

const props = defineProps<{
  title: string
  references?: readonly string[]
  tags?: readonly string[]
  date?: string
  /** Override the active config — used by the settings preview. */
  config?: TrackMetaConfig
}>()

const provided = inject(TRACK_META_CONFIG_KEY, null)
const activeConfig = computed<TrackMetaConfig>(
  () => props.config ?? provided?.value ?? DEFAULT_TRACK_META_CONFIG
)

// Resolved top widget. Only "reference" / "date" are ever promoted here
// (see TOP_FIELD_KEYS); reference falls back to the first tag, same as
// the legacy chip, and counts the hidden extras as "+N".
const top = computed<{ text: string; extra: number } | null>(() => {
  const field = activeConfig.value.top
  if (field === "reference") {
    const refs = props.references ?? []
    const text = refs[0] ?? (props.tags ?? [])[0]
    return text ? { text, extra: Math.max(0, refs.length - 1) } : null
  }
  if (field === "date") {
    return props.date ? { text: props.date, extra: 0 } : null
  }
  return null
})
</script>

<template>
  <h3 class="title-block">
    <!-- The prominent top widget sits inline on the title row, exactly
         where the scripture reference chip always lived. Which field it
         shows (reference / date / nothing) is configurable. -->
    <template v-if="top">
      <span class="reference">{{ top.text }}</span>
      <span v-if="top.extra" class="reference extra">+{{ top.extra }}</span>
    </template>
    <span class="title">{{ title }}</span>
  </h3>
</template>

<style scoped>
.title-block {
  display: flex;
  align-items: center;
  gap: 5px;
}

.title {
  text-overflow: ellipsis;
  overflow: hidden;
}

.reference {
  flex: 0 0 auto;
  background-color: var(--ion-color-light-shade);
  font-weight: bold;
  color: var(--ion-color-medium);
  border-radius: 5px;
  padding: 0px 5px;
  font-size: 0.8em;
  font-stretch: condensed;
}

.reference.extra {
  opacity: 0.5;
}
</style>
