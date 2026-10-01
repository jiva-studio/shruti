<script setup lang="ts">
import { computed } from "vue"
import TrackTile from "@shruti/components/TrackTile.vue"
import { trackName, type DiscoveryHit } from "@lib/contracts"
import { useWebLectureAdd } from "../composables/useWebLectureAdd.js"
import { useOpenAddedLecture } from "@shruti/composables/useOpenAddedLecture.js"
import { useWebTrackSheetStore } from "@shruti/stores/useWebTrackSheetStore.js"

const props = defineProps<{ hit: DiscoveryHit }>()

const add = useWebLectureAdd(() => props.hit)
const added = useOpenAddedLecture()
const webTrackSheet = useWebTrackSheetStore()

const title = computed(() => trackName(props.hit))

const subtitle = computed(() =>
  [props.hit.author, props.hit.recorded_on?.slice(0, 10)].filter(Boolean).join(" · ")
)

function onAdd(): void {
  void add.add()
}

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
    :status="add.state.value"
    :progress="{ label: add.stageLabel.value, percent: add.percent.value }"
    :can-retry="true"
    :add-label="$t('search.web.add')"
    :selectable="true"
    @add="onAdd"
    @retry="onAdd"
    @select="onSelect"
  />
</template>
