<template>
  <div v-if="items.length" class="similar">
    <h3 class="heading">{{ t("transcript.similarByTopic") }}</h3>
    <button
      v-for="it in items"
      :key="it.trackId"
      type="button"
      class="row"
      @click="emit('select', it.trackId)"
    >
      <span class="title">{{ it.title }}</span>
      <span v-if="it.reason" class="reason">{{ it.reason }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const props = defineProps<{ track: Track }>()
const emit = defineEmits<{ (e: "select", trackId: TrackId): void }>()

const { t } = useI18n()
const app = useLectorium()
const dictionaries = useDictionariesStore()
const mapper = useTrackUiStateMapper()

// How many of the seed's top topics define "similar", how many neighbours to
// show, and how many shared topics to name in the reason line.
const SEED_TOPICS = 5
const SIMILAR_LIMIT = 5
const REASON_TOPICS = 2

interface SimilarItem {
  readonly trackId: TrackId
  readonly title: string
  readonly reason: string
}

const items = ref<readonly SimilarItem[]>([])

async function load(track: Track): Promise<void> {
  items.value = []
  const seedTopics = track.topicIds.slice(0, SEED_TOPICS)
  if (seedTopics.length === 0) return
  try {
    const repos = app.repositories()
    await dictionaries.ensureLoaded()
    const ids = await repos.topics.similarTrackIds(seedTopics, track.id, SIMILAR_LIMIT)
    if (ids.length === 0) return
    const byId = await repos.tracks.getByIds([...ids])
    const seedSet = new Set(track.topicIds)
    items.value = ids
      .map((id) => byId.get(id))
      .filter((n): n is Track => n !== undefined)
      .map((n) => {
        const shared = n.topicIds
          .filter((tid) => seedSet.has(tid))
          .slice(0, REASON_TOPICS)
          .map((tid) => dictionaries.topicNamesById.get(tid) ?? tid)
        return {
          trackId: n.id,
          title: mapper.toUiRow(n).title,
          reason: shared.length ? t("transcript.similarByTopicReason", { topics: shared.join(", ") }) : "",
        }
      })
  } catch (err) {
    console.warn("[similar] load failed", err)
    items.value = []
  }
}

watch(() => props.track, (track) => void load(track), { immediate: true })
</script>

<style scoped>
.similar {
  padding: 8px 16px 16px;
}
.heading {
  margin: 0 0 8px;
  font-size: 1rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 8px 0;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
}
.row + .row {
  border-top: 1px solid var(--ion-color-step-100, rgba(0, 0, 0, 0.08));
}
.title {
  font-size: 0.95rem;
  color: var(--ion-text-color);
}
.reason {
  font-size: 0.8rem;
  color: var(--ion-color-medium-shade);
}
</style>
