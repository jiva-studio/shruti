<script setup lang="ts">
import { computed } from "vue"
import TrackTile from "@shruti/components/TrackTile.vue"
import { resolveDiscoverySource, trackName, type DiscoveryHit } from "@lib/contracts"
import { useOpenAddedLecture } from "@shruti/composables/useOpenAddedLecture.js"
import { useWebTrackSheetStore } from "@shruti/stores/useWebTrackSheetStore.js"

const props = defineProps<{ hit: DiscoveryHit }>()

const added = useOpenAddedLecture()
const webTrackSheet = useWebTrackSheetStore()

const title = computed(() => trackName(props.hit))
const source = computed(() => resolveDiscoverySource(props.hit))

const subtitle = computed(() =>
  [source.value.name, props.hit.author, props.hit.recorded_on?.slice(0, 10)]
    .filter(Boolean)
    .join(" · ")
)

function onSelect(): void {
  if (added.canOpen(props.hit.media_url)) {
    added.open(props.hit.media_url)
  } else {
    webTrackSheet.open(props.hit)
  }
}
</script>

<template>
  <TrackTile
    :cover="hit.cover_url"
    :title="title"
    :subtitle="subtitle"
    status="ready"
    :selectable="true"
    @select="onSelect"
  />
</template>
