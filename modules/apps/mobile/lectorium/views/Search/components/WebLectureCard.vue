<template>
  <TrackTile
    :title="title"
    :subtitle="subtitle"
    :cover="hit.media_url"
    :status="add.state.value"
    :progress="{ label: add.stageLabel.value, percent: add.percent.value }"
    :can-retry="true"
    :add-label="$t('search.web.add')"
    @add="onAdd"
    @retry="onAdd"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import TrackTile from "@lectorium/components/TrackTile.vue"
import type { DiscoveryHit } from "@lib/contracts"
import { useWebLectureAdd } from "../composables/useWebLectureAdd.js"

/**
 * A track found on an archive we do not own, as a tile in the search results —
 * the same `TrackTile` the personal library is made of, because that is what it
 * becomes the moment somebody taps the plus. The corner then stops being an
 * offer and starts reporting the stage, on the very same tile.
 *
 * The cover is the address the service gave, used as it came.
 */
const props = defineProps<{ hit: DiscoveryHit }>()

const add = useWebLectureAdd(() => props.hit)

const title = computed(() => props.hit.title || props.hit.media_url)

const subtitle = computed(() =>
  [props.hit.author, props.hit.recorded_on?.slice(0, 10)].filter(Boolean).join(" · ")
)

function onAdd(): void {
  void add.add()
}
</script>
