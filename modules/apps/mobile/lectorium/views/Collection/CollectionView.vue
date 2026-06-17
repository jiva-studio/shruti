<template>
  <IonPage>
    <IonHeader class="hero-header ion-no-border">
      <IonToolbar class="hero-toolbar" :class="{ solid: titleShown }" :style="toolbarStyle">
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle :style="{ opacity: titleOpacity }">{{ title }}</IonTitle>
        <IonButtons slot="end">
          <IonButton
            class="no-ripple"
            :disabled="adding || trackIds.length === 0"
            :aria-label="t('search.collections.addAll')"
            @click="onAdd"
          >
            <IconPlaylistAdd :size="24" />
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>

    <IonContent :fullscreen="true" :scroll-events="true" @ionScroll="onScroll">
      <div class="hero" :style="{ opacity: heroOpacity }">
        <div class="hero-media" :style="{ transform: `translateY(${heroShift}px)` }">
          <CachedImage v-if="coverUrl" :url="coverUrl" :alt="title" />
        </div>
        <span class="hero-scrim" aria-hidden="true" />
        <div class="hero-caption">
          <h1 class="hero-title">{{ title }}</h1>
        </div>
      </div>

      <p v-if="description" class="description">{{ description }}</p>

      <div v-if="loading" class="detail-loading">
        <IonSpinner name="crescent" />
      </div>
      <TracksList v-else :rows="rows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  alertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { IconPlaylistAdd } from "@tabler/icons-vue"
import { CachedImage } from "@ui/primitives/index.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { addTracksToPlaylist } from "@usecases"
import { useToast } from "@kit/composables"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

// One detail page for any track-bearing entity: a collection or a recommender
// topic. The `kind` (from the route) selects how the header + tracks load; the
// hero / toolbar / "add all" chrome is shared.
const props = defineProps<{ id: string; kind?: "collection" | "topic" }>()

const { t } = useI18n()
const app = useLectorium()
const playlist = usePlaylistStore()
const dictionaries = useDictionariesStore()
const toast = useToast()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()

const TOPIC_TRACKS = 50

const title = ref("")
const description = ref<string | null>(null)
const coverKey = ref<string | null>(null)
const trackIds = ref<readonly string[]>([])
const tracks = ref<readonly Track[]>([])
const adding = ref(false)
const loading = ref(false)

const coverUrl = computed(() => (coverKey.value ? resolveAssetUrl(coverKey.value) : undefined))
const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })

const HERO_HEIGHT = 240
const scrollTop = ref(0)
function onScroll(e: CustomEvent<{ scrollTop: number }>): void {
  scrollTop.value = e.detail.scrollTop
}

// Hero fades + parallaxes out over its own height; the toolbar title fades in
// over the last stretch so it takes over exactly as the hero leaves.
const heroOpacity = computed(() => Math.max(0, 1 - scrollTop.value / HERO_HEIGHT))
const heroShift = computed(() => scrollTop.value * 0.4)
const titleOpacity = computed(() =>
  Math.min(1, Math.max(0, (scrollTop.value - (HERO_HEIGHT - 120)) / 100))
)
const titleShown = computed(() => titleOpacity.value > 0.5)
const toolbarStyle = computed(() => ({
  "--background": `rgba(var(--ion-background-color-rgb), ${titleOpacity.value})`,
}))

// Sequence token: `collection` and `topic-tracks` share this component, and an
// in-place language switch re-runs load() without re-mounting. Without a guard
// an older multi-await load can overwrite the title/tracks/cover with stale data.
let loadGen = 0

async function load(kind: string, id: string, locale: string): Promise<void> {
  const myGen = ++loadGen
  loading.value = true
  title.value = ""
  description.value = null
  coverKey.value = null
  trackIds.value = []
  tracks.value = []
  try {
    const repos = app.repositories()
    let ids: readonly string[] = []
    if (kind === "topic") {
      await dictionaries.ensureLoaded()
      if (myGen !== loadGen) return
      title.value = dictionaries.topicNamesById.get(id) ?? id
      coverKey.value = dictionaries.topicCoverById.get(id) ?? null
      // Topic membership is filtered to the library languages in SQL.
      ids = await repos.topics.topTrackIds(
        id as TopicId,
        libraryLanguages.value as LanguageCode[],
        TOPIC_TRACKS
      )
    } else {
      const d = await repos.collections.getCollection(id, locale)
      if (myGen !== loadGen) return
      if (!d) return
      title.value = d.name
      description.value = d.description || null
      coverKey.value = d.cover || null
      ids = d.trackIds
    }
    if (myGen !== loadGen) return
    if (ids.length === 0) {
      trackIds.value = []
      return
    }
    const byId = await repos.tracks.getByIds([...ids])
    if (myGen !== loadGen) return
    const hydrated = ids.map((tid) => byId.get(tid)).filter((tr): tr is Track => tr !== undefined)
    // A curated collection can mix languages; show only tracks the user can
    // consume in their library languages. Topic membership is already filtered
    // in SQL, and an empty language set means "no filter".
    const langs = libraryLanguages.value
    const visible =
      kind === "topic" || langs.length === 0
        ? hydrated
        : hydrated.filter((tr) => tr.variants.some((v) => langs.includes(v.language)))
    tracks.value = visible
    trackIds.value = visible.map((tr) => tr.id)
  } catch (err) {
    console.warn("[detail] load failed", err)
  } finally {
    if (myGen === loadGen) loading.value = false
  }
}

watch(
  () => [props.id, props.kind ?? "collection", appLanguage.value, libraryLanguages.value] as const,
  ([id, kind, locale]) => void load(kind, id, locale),
  { immediate: true }
)

async function onSelectTrack(trackId: string): Promise<void> {
  await trackActions.present(trackId as TrackId)
}

async function onAdd(): Promise<void> {
  const count = trackIds.value.length
  if (count === 0) return
  const alert = await alertController.create({
    header: t("search.collections.addAll"),
    message: t("search.collections.addConfirm", { count }, count),
    buttons: [
      { text: t("app.cancel"), role: "cancel" },
      { text: t("app.ok"), role: "confirm", handler: () => void performAdd() },
    ],
  })
  await alert.present()
}

async function performAdd(): Promise<void> {
  if (trackIds.value.length === 0) return
  adding.value = true
  // Stamp provenance only for real collections; a topic shelf is not a
  // collection, so its tracks stay standalone (no false grouping).
  const sourceCollectionId = (props.kind ?? "collection") === "collection" ? props.id : null
  try {
    const result = await addTracksToPlaylist(
      { trackIds: [...trackIds.value] },
      { playlist: { add: (id) => playlist.add(id, sourceCollectionId) } }
    )
    if (!result.ok) void toast.error(t("search.collections.addError"))
  } catch {
    void toast.error(t("search.collections.addError"))
  } finally {
    adding.value = false
  }
}
</script>

<style scoped>
.hero-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
}

.hero-header::after {
  display: none;
}

.hero-toolbar {
  --background: rgba(var(--ion-background-color-rgb), 0);
  --border-width: 0;
}

.hero-toolbar ion-back-button,
.hero-toolbar ion-buttons ion-button,
.hero-toolbar ion-buttons ion-button :deep(svg) {
  --color: var(--lectorium-scrim-cream);
  color: var(--lectorium-scrim-cream);
}

.hero-toolbar.solid ion-back-button,
.hero-toolbar.solid ion-buttons ion-button,
.hero-toolbar.solid ion-buttons ion-button :deep(svg) {
  --color: var(--ion-text-color);
  color: var(--ion-text-color);
}

.hero-toolbar ion-title {
  transition: opacity 120ms ease;
}

.hero {
  position: relative;
  height: 240px;
  margin-bottom: 8px;
  overflow: hidden;
  background: var(--ion-color-light);
}

.hero-media {
  position: absolute;
  inset: -40px 0;
}

.hero-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(20, 14, 9, 0.55) 0%,
    rgba(20, 14, 9, 0) 26%,
    rgba(20, 14, 9, 0) 50%,
    rgba(20, 14, 9, 0.88) 100%
  );
  pointer-events: none;
}

.hero-caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 16px 16px 14px;
}

.hero-title {
  margin: 0 0 4px;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--lectorium-scrim-cream);
}

.description {
  margin: 0;
  padding: 14px 16px 4px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ion-color-medium-shade);
}

.detail-loading {
  display: flex;
  justify-content: center;
  padding: 32px 0;
  color: var(--ion-color-medium);
}
</style>
