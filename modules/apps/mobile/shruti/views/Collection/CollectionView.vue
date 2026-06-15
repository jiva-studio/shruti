<template>
  <IonPage>
    <IonHeader class="hero-header ion-no-border">
      <IonToolbar class="hero-toolbar" :class="{ solid: titleShown }" :style="toolbarStyle">
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle :style="{ opacity: titleOpacity }">{{ detail?.name ?? "" }}</IonTitle>
        <IonButtons slot="end">
          <IonButton
            class="no-ripple"
            :disabled="adding || !detail || detail.trackIds.length === 0"
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
          <CachedImage v-if="coverUrl" :url="coverUrl" :alt="detail?.name" />
        </div>
        <span class="hero-scrim" aria-hidden="true" />
        <div class="hero-caption">
          <h1 class="hero-title">{{ detail?.name ?? "" }}</h1>
        </div>
      </div>

      <p v-if="detail?.description" class="description">{{ detail.description }}</p>

      <TracksList :rows="rows" @select="onSelectTrack">
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
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { IconPlaylistAdd } from "@tabler/icons-vue"
import { CachedImage } from "@ui/primitives/index.js"
import { resolveAssetUrl } from "@shruti/services/regionsRegistry.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { useShruti } from "@shruti/shruti.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@shruti/composables/useTrackActionSheet.js"
import { addTracksToPlaylist } from "@lib/application"
import { useToast } from "@kit/composables"
import type { TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { CollectionDetail } from "@infra/repositories/sql/index.js"

const props = defineProps<{ id: string }>()

const { t } = useI18n()
const app = useShruti()
const playlist = usePlaylistStore()
const toast = useToast()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()
const appLanguage = useAppLanguage()

const detail = ref<CollectionDetail | null>(null)
const tracks = ref<readonly Track[]>([])
const adding = ref(false)

const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })

const HERO_HEIGHT = 240
const coverUrl = computed(() => (detail.value?.cover ? resolveAssetUrl(detail.value.cover) : undefined))

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

async function load(id: string, locale: string): Promise<void> {
  detail.value = null
  tracks.value = []
  try {
    const repos = app.repositories()
    const d = await repos.collections.getCollection(id, locale)
    detail.value = d
    if (!d || d.trackIds.length === 0) return
    const byId = await repos.tracks.getByIds([...d.trackIds])
    tracks.value = d.trackIds
      .map((tid) => byId.get(tid))
      .filter((tr): tr is Track => tr !== undefined)
  } catch (err) {
    console.warn("[collection] load failed", err)
    detail.value = null
    tracks.value = []
  }
}

watch(
  () => [props.id, appLanguage.value] as const,
  ([id, locale]) => void load(id, locale),
  { immediate: true }
)

async function onSelectTrack(trackId: string): Promise<void> {
  await trackActions.present(trackId as TrackId)
}

async function onAdd(): Promise<void> {
  const count = detail.value?.trackIds.length ?? 0
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
  if (!detail.value || detail.value.trackIds.length === 0) return
  adding.value = true
  try {
    const result = await addTracksToPlaylist(
      { trackIds: [...detail.value.trackIds] },
      { playlist: { add: (id) => playlist.add(id) } }
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
  --color: #f4ebdd;
  color: #f4ebdd;
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
  color: #f4ebdd;
}

.description {
  margin: 0;
  padding: 14px 16px 4px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ion-color-medium-shade);
}
</style>
