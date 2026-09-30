<script setup lang="ts">
import { onMounted, ref, watch } from "vue"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import OnboardingHeading from "@ui/features/onboarding/OnboardingHeading.vue"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useCatalogUseCases } from "@shruti/wiring/catalogUseCases.js"
import { useOnboardingUseCases } from "@shruti/wiring/onboardingUseCases.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"

const props = defineProps<{
  topicIds: readonly string[]
  /** Topics confirmed (user left the topics screen) — start seeding + prefetch
   *  now, so the download is already running by the time this screen shows. */
  seed?: boolean
}>()

const catalog = useCatalogUseCases()
const onboarding = useOnboardingUseCases()
const mapper = useTrackUiStateMapper()
const libraryLanguages = useLibraryLanguages()
const playlist = usePlaylistStore()

const tracks = ref<readonly Track[]>([])
// Same "discovery" mapping Search/Library use, so rows render with real titles,
// references, duration and a live download/play state indicator.
const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })

let gen = 0
async function load(): Promise<void> {
  const myGen = ++gen
  try {
    const langs = libraryLanguages.value as LanguageCode[]
    const seeds = props.topicIds.slice(0, 4) as TopicId[]
    // Picked topics → lectures from those topics. Fall back to the featured
    // "for beginners" collection when nothing was picked or the picked topics
    // have no lectures in the user's library language, so the screen is never
    // empty.
    let ids = seeds.length > 0 ? await onboarding.pickTopicLectures(seeds, langs) : []
    if (ids.length === 0) ids = await onboarding.pickBeginnerLectures(langs)
    const byId = await catalog.findTracks(ids)
    const out: Track[] = []
    for (const id of ids) {
      const t = byId.get(id)
      if (t) out.push(t)
    }
    if (myGen === gen) {
      tracks.value = out
      await seedPlaylist(out)
    }
  } catch (err) {
    // DB may not be open yet on the very first paint; the topicIds watch
    // re-runs once the curated set resolves.
    console.warn("[onboarding] value lectures load failed", err)
    if (myGen === gen) tracks.value = []
  }
}

// As soon as topics are confirmed (the user left the topics screen), seed the
// playlist with the matched lectures — each add() kicks off the audio prefetch,
// so the download is already running while the user finishes the remaining
// screens and Home is populated on arrival. Idempotent (add() skips dupes),
// runs once.
//
// Takes the list `load` just resolved rather than reading `tracks`: `seed`
// flips while a reload is in flight, and a watcher of its own would seed from
// the list being replaced — the screen would then name five lectures and Home
// would show the five of the next shuffle. The ref is assigned before
// the first await here, so the paint does not wait on the adds.
let seeded = false
async function seedPlaylist(list: readonly Track[]): Promise<void> {
  if (seeded || !props.seed || list.length === 0) return
  seeded = true
  for (const t of list) {
    await playlist.add(t.id as TrackId).catch((err: unknown) => reportError("onboarding", err))
  }
}

onMounted(load)
// Reload on topic change, and again when the user reaches the value flow
// (`seed`) — by then the content DB is open and the picks have propagated, so a
// load that no-op'd on the very first paint gets a real result.
watch([() => props.topicIds, () => props.seed], load)
</script>

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
