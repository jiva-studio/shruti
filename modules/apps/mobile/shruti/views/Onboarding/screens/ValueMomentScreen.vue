<template>
  <div class="ob-value">
    <OnboardingHeading
      :title="$t('onboarding.value.title')"
      :subtitle="$t('onboarding.value.subtitle')"
    />
    <!-- Display-only preview: tapping a row opens nothing during onboarding. -->
    <TracksList v-if="rows.length > 0" :rows="rows" data-testid="onboarding-lectures">
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
import OnboardingHeading from "@ui/features/onboarding/OnboardingHeading.vue"
import { useShruti } from "@shruti/shruti.js"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"

const props = defineProps<{
  topicIds: readonly string[]
  /** Topics confirmed (user left the topics screen) — start seeding + prefetch
   *  now, so the download is already running by the time this screen shows. */
  seed?: boolean
}>()

const app = useShruti()
const mapper = useTrackUiStateMapper()
const libraryLanguages = useLibraryLanguages()
const playlist = usePlaylistStore()

const tracks = ref<readonly Track[]>([])
// Same "discovery" mapping Search/Library use, so rows render with real titles,
// references, duration and a live download/play state indicator.
const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })

const LIMIT = 5
const POOL_PER_TOPIC = 12

let gen = 0
async function load(): Promise<void> {
  const myGen = ++gen
  try {
    const repos = app.repositories()
    const langs = libraryLanguages.value as LanguageCode[]
    const seeds = props.topicIds.slice(0, 4) as TopicId[]
    // Picked topics → lectures from those topics. Fall back to the featured
    // "for beginners" collection when nothing was picked OR the picked topics
    // have no lectures in the user's library language, so the screen is never
    // empty.
    let ids = seeds.length > 0 ? await trackIdsForTopics(repos, seeds, langs) : []
    if (ids.length === 0) ids = await beginnerTrackIds(repos, langs)
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
  // Gather a pool from the picked topics (untagged lectures tied to a verse —
  // the strongest first listens), then pick LIMIT at random so the screen
  // varies instead of always showing the same top-weighted few.
  const pool: TrackId[] = []
  const seen = new Set<string>()
  for (const topic of seeds) {
    const tids = await repos.topics.topTrackIds(topic, langs, POOL_PER_TOPIC, {
      lecturesOnly: true,
      withReference: true,
    })
    for (const id of tids) {
      if (!seen.has(id)) {
        seen.add(id)
        pool.push(id)
      }
    }
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, LIMIT)
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

// As soon as topics are confirmed (the user left the topics screen), seed the
// playlist with the matched lectures — each add() kicks off the audio prefetch,
// so the download is already running while the user finishes the remaining
// screens and Home is populated on arrival. Idempotent (add() skips dupes),
// runs once.
let seeded = false
async function seedPlaylist(): Promise<void> {
  if (seeded || !props.seed || tracks.value.length === 0) return
  seeded = true
  for (const t of tracks.value) {
    await playlist.add(t.id as TrackId).catch(() => undefined)
  }
}

onMounted(load)
// Reload on topic change, and again when the user reaches the value flow
// (`seed`) — by then the content DB is open and the picks have propagated, so a
// load that no-op'd on the very first paint gets a real result.
watch([() => props.topicIds, () => props.seed], load)
watch([() => props.seed, tracks], seedPlaylist)
</script>

<style scoped>
.ob-value {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 8px 24px;
  box-sizing: border-box;
}
.ob-value__empty {
  text-align: center;
  color: var(--ion-color-medium);
}
</style>
