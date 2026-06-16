<template>
  <div v-if="rows.length" class="similar">
    <SectionLabel inset>{{ t("transcript.similarByTopic") }}</SectionLabel>
    <TracksList :rows="rows" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { TracksList } from "@ui/components/tracks/list/index.js"
import SectionLabel from "@ui/components/SectionLabel.vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { listSimilarTracksByTopic } from "@lib/application/listSimilarTracksByTopic.js"
import type { Track } from "@lib/domain/track.js"

const props = defineProps<{ track: Track }>()

const { t } = useI18n()
const app = useLectorium()
const mapper = useTrackUiStateMapper()

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
      { track, seedTopics: SEED_TOPICS, limit: SIMILAR_LIMIT },
      app.repositories()
    )
    if (myGen === gen) similar.value = result
  } catch (err) {
    console.warn("[similar] load failed", err)
    if (myGen === gen) similar.value = []
  }
}

watch(
  () => props.track,
  (track) => void load(track),
  { immediate: true }
)
</script>
