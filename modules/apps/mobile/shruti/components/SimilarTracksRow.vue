<template>
  <div v-if="rows.length" class="similar">
    <h3 class="contents-title">{{ t("transcript.similarByTopic") }}</h3>
    <TracksList :rows="rows" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import type { Track } from "@lib/domain/track.js"

const props = defineProps<{ track: Track }>()

const { t } = useI18n()
const app = useShruti()
const mapper = useTrackUiStateMapper()

const SEED_TOPICS = 5
const SIMILAR_LIMIT = 5

const similar = ref<readonly Track[]>([])
const rows = mapper.mapRows(() => similar.value, { context: "discovery" })

async function load(track: Track): Promise<void> {
  similar.value = []
  const seedTopics = track.topicIds.slice(0, SEED_TOPICS)
  if (seedTopics.length === 0) return
  try {
    const repos = app.repositories()
    const ids = await repos.topics.similarTrackIds(seedTopics, track.id, SIMILAR_LIMIT)
    if (ids.length === 0) return
    const byId = await repos.tracks.getByIds([...ids])
    similar.value = ids.map((id) => byId.get(id)).filter((n): n is Track => n !== undefined)
  } catch (err) {
    console.warn("[similar] load failed", err)
    similar.value = []
  }
}

watch(
  () => props.track,
  (track) => void load(track),
  { immediate: true }
)
</script>

<style scoped>
.contents-title {
  margin: 16px 0 4px;
  padding-inline: var(--ion-padding, 16px);
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ion-color-medium, #777);
}
</style>
