<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import TrackTile, { type TileStatus } from "@lectorium/components/TrackTile.vue"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

/**
 * One personal-library item as a square cover tile.
 *
 * The tile itself is `TrackTile`, shared with the search results — a track
 * found on another archive is the same object in the same states, one nobody
 * has added yet. This is the adapter: it turns a `LibraryItem` and the live
 * ingest poll into what the tile understands.
 *
 * A row without a track id has nothing to open (`useOpenLibraryItem` would
 * no-op), so it does not offer the tap either.
 */
const props = defineProps<{ item: LibraryItem }>()

const emit = defineEmits<{
  (e: "select", item: LibraryItem): void
  (e: "retry", item: LibraryItem): void
}>()

const { t, te } = useI18n()
const library = useLibraryStore()

const status = computed<TileStatus>(() => {
  if (props.item.status === "ready") return "ready"
  if (props.item.status === "failed") return "failed"
  return "pending"
})

const coverUrl = computed(() => resolveAssetUrl(props.item.coverKey ?? undefined))
const title = computed(() => props.item.titleRaw?.trim() || t("library.untitled"))

const subtitle = computed(() => {
  const parts = [props.item.authorRaw, props.item.locationRaw, props.item.dateRaw].filter(
    (p): p is string => !!p && p.trim().length > 0
  )
  return parts.join(" · ")
})

// Live pipeline stage from the status poll (Downloading / Transcribing / …),
// falling back to a plain "Processing" before the first heartbeat / unknown code.
const livePercent = computed(() => library.livePercents.get(props.item.id))
// Stage name only — the progress ring conveys the percent, no need to repeat it.
const stageLabel = computed(() => {
  const stage = library.liveStages.get(props.item.id)
  const key = stage ? `library.status.stages.${stage}` : ""
  return key && te(key) ? t(key) : t("library.status.processing")
})

// The server ships a STABLE failure code (e.g. "unavailable"); map it to a
// localized reason, falling back to the generic message for an unknown code.
const errorMessage = computed(() => {
  const key = `library.status.errors.${props.item.error ?? "internal"}`
  return te(key) ? t(key) : t("library.status.errors.internal")
})

// A failed item can be retried only when we still know the source URL to re-add
// (older rows predate source_url).
const canRetry = computed(() => props.item.status === "failed" && !!props.item.sourceUrl)
</script>

<template>
  <TrackTile
    :title="title"
    :subtitle="subtitle"
    :cover="coverUrl"
    :status="status"
    :progress="{ label: stageLabel, percent: livePercent }"
    :can-retry="canRetry"
    :error-message="errorMessage"
    :selectable="!!item.trackId"
    @select="emit('select', item)"
    @retry="emit('retry', item)"
  />
</template>
