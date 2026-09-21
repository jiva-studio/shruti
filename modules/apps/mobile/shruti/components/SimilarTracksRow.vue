<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { TracksList } from "@ui/components/tracks/list/index.js"
import SectionLabel from "@ui/components/SectionLabel.vue"
import { useShruti } from "@shruti/shruti.js"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useTrackActionSheet } from "@shruti/composables/useTrackActionSheet.js"
import { listSimilarTracksByTopic } from "@usecases/discovery/listSimilarTracksByTopic.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"

const props = defineProps<{ track: Track }>()

const { t } = useI18n()
const app = useShruti()
const mapper = useTrackUiStateMapper()
const libraryLanguages = useLibraryLanguages()
const trackActions = useTrackActionSheet()

// Tapping a similar lecture re-opens the same sheet for that track: the shared
// TrackSheet swaps its content in place (and scrolls back to the top).
function onSelectSimilar(trackId: string): void {
  void trackActions.present(trackId as TrackId)
}

const SEED_TOPICS = 5
const SIMILAR_LIMIT = 5

const similar = ref<readonly Track[]>([])
const rows = mapper.mapRows(() => similar.value, { context: "discovery" })

// Sequence token: props.track can swap while a load is in flight.
let gen = 0

async function load(track: Track): Promise<void> {
  const myGen = ++gen
  similar.value = []
  try {
    const result = await listSimilarTracksByTopic(
      {
        track,
        seedTopics: SEED_TOPICS,
        languages: libraryLanguages.value as LanguageCode[],
        limit: SIMILAR_LIMIT,
      },
      app.repositories()
    )
    if (myGen === gen) similar.value = result
  } catch (err) {
    console.warn("[similar] load failed", err)
    if (myGen === gen) similar.value = []
  }
}

watch(
  () => [props.track, libraryLanguages.value] as const,
  ([track]) => void load(track),
  { immediate: true }
)
</script>

<template>
  <div v-if="rows.length" class="similar">
    <SectionLabel inset>{{ t("transcript.similarByTopic") }}</SectionLabel>
    <TracksList :rows="rows" @select="onSelectSimilar" />
  </div>
</template>
