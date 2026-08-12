<template>
  <TrackTile
    :cover="hit.cover_url"
    :title="title"
    :subtitle="subtitle"
    :status="add.state.value"
    :progress="{ label: add.stageLabel.value, percent: add.percent.value }"
    :can-retry="true"
    :add-label="$t('search.web.add')"
    :selectable="added.canOpen(hit.media_url)"
    @add="onAdd"
    @retry="onAdd"
    @select="added.open(hit.media_url)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import TrackTile from "@lectorium/components/TrackTile.vue"
import { trackName, type DiscoveryHit } from "@lib/contracts"
import { useWebLectureAdd } from "../composables/useWebLectureAdd.js"
import { useOpenAddedLecture } from "@lectorium/composables/useOpenAddedLecture.js"

/**
 * A track found on an archive we do not own, as a tile in the search results —
 * the same `TrackTile` the personal library is made of, because that is what it
 * becomes the moment somebody taps the plus. The corner then stops being an
 * offer and starts reporting the stage, on the very same tile.
 *
 * The cover is `cover_url`, the picture the archive publishes — the service
 * works it out and hands it over ready to show. Nothing is derived here, and
 * the media address never reaches an <img>: it is an mp3 or a watch page, and
 * pointing a tile at it made the app fetch the recording itself from somebody
 * else's archive on every search.
 *
 * Once added it is a lecture the user owns, and tapping it opens the sheet the
 * library tile opens. A tile that cannot resolve one stays a picture rather
 * than a button that swallows the tap (#1788).
 */
const props = defineProps<{ hit: DiscoveryHit }>()

const add = useWebLectureAdd(() => props.hit)
const added = useOpenAddedLecture()

const title = computed(() => trackName(props.hit))

const subtitle = computed(() =>
  [props.hit.author, props.hit.recorded_on?.slice(0, 10)].filter(Boolean).join(" · ")
)

function onAdd(): void {
  void add.add()
}
</script>
