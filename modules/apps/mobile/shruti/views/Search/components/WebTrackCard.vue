<script setup lang="ts">
import { computed } from "vue"
import TrackTile from "@shruti/components/TrackTile.vue"
import { trackName, type DiscoveryHit } from "@lib/contracts"
import { useWebLectureAdd } from "../composables/useWebLectureAdd.js"
import { useOpenAddedLecture } from "@shruti/composables/useOpenAddedLecture.js"

/**
 * A track found on an archive we do not own, as a tile in the search results —
 * the same `TrackTile` the personal library is made of, because that is what it
 * becomes the moment somebody taps the plus. The corner then stops being an
 * offer and starts reporting the stage, on the very same tile.
 *
 * The cover is `cover_url`, the picture the archive publishes — the service
 * works it out and hands it over ready to show. Nothing is derived here, and
 * the media address never reaches an <img>: it is an mp3 or a watch page, and
 * pointing a tile at it would make the app fetch the recording itself from
 * somebody else's archive on every search.
 *
 * Once added it is a lecture the user owns, and tapping it opens the sheet the
 * library tile opens. A tile that cannot resolve one stays a picture rather
 * than a button that swallows the tap.
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

<template>
  <div class="web-track-card">
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
    <div v-if="hit.summary || hit.highlight" class="web-track-card__details">
      <p v-if="hit.summary" class="web-track-card__summary">{{ hit.summary }}</p>
      <blockquote v-if="hit.highlight" class="web-track-card__quote">
        “{{ hit.highlight }}”
      </blockquote>
    </div>
  </div>
</template>

<style scoped>
.web-track-card {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.web-track-card__details {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.web-track-card__summary {
  margin: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--ion-color-step-700, #444);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.web-track-card__quote {
  margin: 0;
  padding: 4px 6px;
  font-size: 11px;
  line-height: 1.35;
  font-style: italic;
  color: var(--ion-color-medium, #666);
  background: var(--ion-color-light, #f4f5f8);
  border-left: 2px solid var(--ion-color-primary, #3880ff);
  border-radius: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
