<template>
  <div class="ob-value">
    <div class="ob-value__head">
      <h1 class="ob-value__title">{{ $t("onboarding.value.title") }}</h1>
      <p class="ob-value__subtitle">{{ $t("onboarding.value.subtitle") }}</p>
    </div>
    <TracksList
      v-if="rows.length > 0"
      :rows="rows"
      data-testid="onboarding-lectures"
      @select="onSelect"
    >
      <template #state="{ state, progressPct }">
        <TrackStateIndicator :state="state" :progress="progressPct" />
      </template>
    </TracksList>
    <p v-else class="ob-value__empty">{{ $t("onboarding.value.empty") }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"

const props = defineProps<{ topicIds: readonly string[]; active?: boolean }>()

const app = useLectorium()
const mapper = useTrackUiStateMapper()
const libraryLanguages = useLibraryLanguages()
const trackActions = useTrackActionSheet()
const playlist = usePlaylistStore()

const tracks = ref<readonly Track[]>([])
// Same "discovery" mapping Search/Library use, so rows render with real titles,
// references, duration and a live download/play state indicator.
const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })

const LIMIT = 8

let gen = 0
async function load(): Promise<void> {
  const myGen = ++gen
  try {
    const repos = app.repositories()
    const langs = libraryLanguages.value as LanguageCode[]
    const seeds = props.topicIds.slice(0, 4) as TopicId[]
    // Picked topics → lectures from those topics. Nothing picked → seed from the
    // featured "for beginners" collection so the user still gets a real start.
    const ids =
      seeds.length > 0
        ? await trackIdsForTopics(repos, seeds, langs)
        : await beginnerTrackIds(repos, langs)
    const byId = await repos.tracks.getByIds(ids)
    const out: Track[] = []
    for (const id of ids) {
      const t = byId.get(id)
      if (t) out.push(t)
    }
    if (myGen === gen) tracks.value = out
  } catch (err) {
    // DB may not be open yet on the very first paint; the topicIds watch
    // re-runs once the curated set resolves.
    console.warn("[onboarding] value lectures load failed", err)
    if (myGen === gen) tracks.value = []
  }
}

async function trackIdsForTopics(
  repos: ReturnType<typeof app.repositories>,
  seeds: readonly TopicId[],
  langs: LanguageCode[]
): Promise<TrackId[]> {
  const ids: TrackId[] = []
  const seen = new Set<string>()
  for (const topic of seeds) {
    const tids = await repos.topics.topTrackIds(topic, langs, 4)
    for (const id of tids) {
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    if (ids.length >= LIMIT) break
  }
  return ids.slice(0, LIMIT)
}

// First featured ("for beginners") collection that has tracks, across the
// user's content languages (then en/ru as a fallback).
async function beginnerTrackIds(
  repos: ReturnType<typeof app.repositories>,
  langs: LanguageCode[]
): Promise<TrackId[]> {
  const locales = [...new Set([...langs, "en", "ru"])] as LanguageCode[]
  for (const locale of locales) {
    const featured = await repos.collections.listFeaturedCollections(locale)
    for (const col of featured) {
      const tids = await repos.collections.getCollectionTrackIds(col.id, locale)
      if (tids.length > 0) return tids.slice(0, LIMIT) as TrackId[]
    }
  }
  return []
}

function onSelect(trackId: string): void {
  void trackActions.present(trackId as TrackId)
}

// When the user reaches this screen, seed their playlist with the matched
// lectures so Home is already populated. Idempotent (add() skips dupes) and
// runs once; reaching the screen is the explicit "yes, these are my lectures".
let seeded = false
async function seedPlaylist(): Promise<void> {
  if (seeded || !props.active || tracks.value.length === 0) return
  seeded = true
  for (const t of tracks.value) {
    await playlist.add(t.id as TrackId).catch(() => undefined)
  }
}

onMounted(load)
watch(() => props.topicIds, load)
watch([() => props.active, tracks], seedPlaylist)
</script>

<style scoped>
.ob-value {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 8px 24px;
  box-sizing: border-box;
}
.ob-value__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
  padding: 0 12px;
}
.ob-value__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.ob-value__subtitle {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-value__empty {
  text-align: center;
  color: var(--ion-color-medium);
}
</style>
