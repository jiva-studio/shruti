<template>
  <IonModal :is-open="open" class="track-sheet" @did-dismiss="onDismiss">
    <div ref="headerRef" class="sheet-header">
      <IonButton class="close-button" fill="clear" :aria-label="t('app.close')" @click="onDismiss">
        <IconX slot="icon-only" :size="16" />
      </IonButton>
      <div class="sheet-heading">
        <h2 class="sheet-title">{{ title }}</h2>
        <p v-if="author" class="author">{{ author }}</p>
        <p v-if="metaParts.length" class="meta">
          <!-- The venue is the only part allowed to shrink: a long institute
               name must not push the date and length out of view. -->
          <span v-for="(part, i) in metaParts" :key="i" :class="{ shrinkable: part.shrinkable }">
            {{ part.text }}
          </span>
        </p>
      </div>
    </div>
    <IonContent ref="contentRef" :style="contentInsets">
      <div class="sheet-body">
        <TopicChips :names="topicNames" />
        <button
          v-for="c in partOf"
          :key="c.id"
          type="button"
          class="part-of"
          @click="onOpenCollection(c.id)"
        >
          <!-- CachedImage fills its parent absolutely, so it needs a sized,
               relatively-positioned box of its own. -->
          <span v-if="c.coverUrl" class="part-of-cover">
            <CachedImage :url="c.coverUrl" :alt="c.name" />
          </span>
          <span class="part-of-text">
            <span class="part-of-name">{{ c.name }}</span>
            <span class="part-of-place">
              {{ t("search.collections.partOf", { position: c.position, total: c.total }) }}
            </span>
          </span>
          <IconChevronRight class="part-of-chevron" :size="18" />
        </button>
        <p v-if="description" class="description">{{ description }}</p>
        <LectureOutline v-if="chapters.length" :chapters="chapters" granularity="minute" />
      </div>
      <SimilarTracksRow v-if="track" :track="track" />
    </IonContent>

    <IonFooter class="ion-no-border">
      <div ref="footerRef" class="sheet-actions">
        <IonButton
          v-if="isLibraryItem"
          fill="clear"
          class="act icon-act remove-btn"
          :aria-label="t('library.remove')"
          @click="onRemove"
        >
          <IconTrash slot="icon-only" :size="18" />
        </IonButton>
        <IonButton
          fill="clear"
          class="act icon-act share-btn"
          :aria-label="t('search.actions.share')"
          @click="onShare"
        >
          <IconShare slot="icon-only" :size="18" />
        </IonButton>
        <IonButton
          class="act add-btn"
          :disabled="alreadyInPlaylist && !downloadFailed"
          @click="onPrimaryAction"
        >
          <IconReload v-if="downloadFailed" slot="start" :size="18" />
          <IconPlaylistAdd v-else slot="start" :size="18" />
          {{ primaryActionLabel }}
        </IonButton>
      </div>
    </IonFooter>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import { IonButton, IonContent, IonFooter, IonModal } from "@ionic/vue"
import {
  IconChevronRight,
  IconPlaylistAdd,
  IconReload,
  IconShare,
  IconTrash,
  IconX,
} from "@tabler/icons-vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { formatTrackDate } from "@lectorium/composables/formatTrackDate.js"
import { formatListeningDuration } from "@lectorium/composables/formatListeningDuration.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useTrackSheetDetail } from "@lectorium/composables/useTrackSheetDetail.js"
import { useTrackSheetActions } from "@lectorium/composables/useTrackSheetActions.js"
import { useTrackSheetStore } from "@lectorium/stores/useTrackSheetStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import { CachedImage } from "@ui/primitives/index.js"
import LectureOutline from "@ui/components/LectureOutline.vue"
import SimilarTracksRow from "@lectorium/components/SimilarTracksRow.vue"
import TopicChips from "@lectorium/components/TopicChips.vue"

const { t } = useI18n()
const router = useRouter()
const app = useLectorium()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()
const sheet = useTrackSheetStore()
const dictionaries = useDictionariesStore()
const library = useLibraryStore()

// The personal-library item backing this track, if any (matched by content
// hash). Present only for a user-added lecture — a corpus track has none, so
// the "Remove from My library" action stays hidden for it.
const libraryItem = computed(() =>
  sheet.trackId ? library.items.find((i) => i.trackId === sheet.trackId) : undefined
)
const isLibraryItem = computed(() => libraryItem.value !== undefined)

async function onRemove(): Promise<void> {
  const item = libraryItem.value
  if (!item) return
  await library.remove(item.id)
  onDismiss()
}

const contentRef = ref<InstanceType<typeof IonContent> | null>(null)

// Both bars float over the scroll, so the content has to reserve their height
// itself. Measured rather than assumed: the title runs to one, two or three
// lines, and the footer grows a third button for a library item.
const headerRef = ref<HTMLElement | null>(null)
const footerRef = ref<HTMLElement | null>(null)
const headerHeight = ref(0)
const footerHeight = ref(0)

const contentInsets = computed(() => ({
  "--padding-top": `${headerHeight.value}px`,
  "--padding-bottom": `${footerHeight.value}px`,
}))

useResizeObserver(headerRef, (h) => (headerHeight.value = h))
useResizeObserver(footerRef, (h) => (footerHeight.value = h))

/** Track one element's height for as long as it is mounted. */
function useResizeObserver(el: Ref<HTMLElement | null>, onHeight: (h: number) => void): void {
  let observer: ResizeObserver | null = null
  watch(
    el,
    (node) => {
      observer?.disconnect()
      observer = null
      if (!node) return
      observer = new ResizeObserver(() => onHeight(node.offsetHeight))
      observer.observe(node)
      onHeight(node.offsetHeight)
    },
    { immediate: true }
  )
  onUnmounted(() => observer?.disconnect())
}

// Opening a similar lecture swaps content in the same sheet — reset scroll so
// the user starts at the top of the new lecture rather than mid-page.
const { track, authorEntity, authorRaw, locationRaw, selectedLanguage } = useTrackSheetDetail({
  onAfterLoad: () => void contentRef.value?.$el?.scrollToTop?.(300),
})
const { downloadFailed, alreadyInPlaylist, primaryActionLabel, onPrimaryAction, onShare } =
  useTrackSheetActions(track)

const open = computed(() => sheet.trackId !== null)

// Content language for this track: the library language it actually has, so the
// title + transcript match the language the track was surfaced in. Falls back to
// the UI language (and resolveTrackTitle then to the only existing variant).
const contentLang = computed<LanguageCode>(
  () =>
    (track.value
      ? preferredContentLanguage(track.value, libraryLanguages.value, appLanguage.value)
      : undefined) ?? appLanguage.value
)

const effectiveLang = computed<LanguageCode>(() => selectedLanguage.value ?? contentLang.value)

// Title follows the content language; the author NAME is a label and follows the
// UI language.
const title = computed(() => {
  if (!track.value) return ""
  // Never surface the content-hash id as a title — an ingested lecture whose
  // metadata hasn't resolved shows the neutral placeholder, like the card.
  return resolveTrackTitle(track.value, contentLang.value) || t("library.untitled")
})

const author = computed(() => {
  if (authorEntity.value) return resolveLocalizedName(authorEntity.value, appLanguage.value) ?? null
  return authorRaw.value?.trim() || null
})

// Location + date + length read as a single label line under the author.
// Location is resolved from the shared dictionaries cache, and the date and
// length are formatted to match the track lists / chat rows.
const metaParts = computed<readonly { text: string; shrinkable: boolean }[]>(() => {
  if (!track.value) return []
  const parts: { text: string; shrinkable: boolean }[] = []
  const location = track.value.locationId
    ? dictionaries.locationsById.get(track.value.locationId)
    : null
  const loc =
    resolveLocalizedNameOrEmpty(location, appLanguage.value) || locationRaw.value?.trim() || ""
  if (loc) parts.push({ text: loc, shrinkable: true })
  if (track.value.date) {
    parts.push({ text: formatTrackDate(track.value.date, appLanguage.value), shrinkable: false })
  }
  // 0 means no playable audio — say nothing rather than "0m".
  const ms = maxAudioDurationMs(track.value)
  if (ms > 0) parts.push({ text: formatListeningDuration(ms / 1000, t), shrinkable: false })
  return parts
})

const variant = computed(
  () => track.value?.variants.find((v) => v.language === effectiveLang.value) ?? null
)
const description = computed(() => variant.value?.description ?? null)
const chapters = computed<readonly TrackOutlineChapter[]>(() => variant.value?.outline ?? [])

const topicNames = computed<string[]>(() =>
  (track.value?.topicIds ?? []).map((id) => dictionaries.topicShortNamesById.get(id) ?? id)
)

/**
 * The seminars this lecture belongs to. A lecture given inside a retreat reads
 * very differently once you know which one and where it falls in it, and that
 * context is nowhere else on this sheet.
 *
 * Failure is silent: the collection tables may be missing on a bundled catalog
 * older than the schema, and a lecture without its seminar card is still a
 * complete lecture.
 */
const partOf = ref<
  readonly { id: string; name: string; coverUrl?: string; position: number; total: number }[]
>([])

watch(
  [() => sheet.trackId, effectiveLang],
  async ([trackId, lang]) => {
    partOf.value = []
    if (!trackId) return
    const want = trackId
    try {
      const rows = await app.repositories().collections.getCollectionsOfTrack(want, lang)
      // The sheet swaps content in place (a similar lecture opens in the same
      // modal), so a slow answer for the previous track must not land here.
      if (sheet.trackId !== want) return
      partOf.value = rows.map((r) => ({
        id: r.id,
        name: r.name,
        coverUrl: r.cover ? resolveAssetUrl(r.cover) : undefined,
        position: r.position,
        total: r.total,
      }))
    } catch {
      partOf.value = []
    }
  },
  { immediate: true }
)

function onOpenCollection(id: string): void {
  sheet.close()
  void router.push({ name: "collection", params: { id } })
}

function onDismiss(): void {
  sheet.close()
}
</script>

<style scoped>
/* Header and footer float over the scroll, the way the tab bar does: the text
   passes beneath them and fades out rather than stopping at a hard edge. Both
   are laid over the content, so the content reserves their height as padding
   (measured, since the title runs to two or three lines) and the bars
   themselves stay transparent to taps except on their own controls. */
.sheet-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  padding: 14px 16px 12px;
  pointer-events: none;
  /* Opaque under the whole heading, fading only across the padding strip
     below it. A percentage stop would start the fade under the text itself and
     let the scrolling body show through it. */
  background: linear-gradient(
    to bottom,
    rgba(var(--lectorium-fade-bg-rgb), 1) 0,
    rgba(var(--lectorium-fade-bg-rgb), 1) calc(100% - 12px),
    rgba(var(--lectorium-fade-bg-rgb), 0.85) calc(100% - 6px),
    rgba(var(--lectorium-fade-bg-rgb), 0) 100%
  );
}

.sheet-header > * {
  pointer-events: auto;
}

.description {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ion-text-color, #222);
}

/* The seminar this lecture belongs to. Sits above the description because it
   frames everything below it: the same talk reads differently as the third
   evening of a retreat than as a standalone. */
.part-of {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 0 0 16px;
  padding: 8px;
  border: none;
  border-radius: 10px;
  background: var(--ion-color-light);
  text-align: left;
  cursor: pointer;
}

.part-of-cover {
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--ion-color-light-shade);
}

.part-of-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.part-of-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ion-text-color, #222);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.part-of-place {
  font-size: 13px;
  color: var(--ion-color-medium);
}

.part-of-chevron {
  flex: 0 0 auto;
  color: var(--ion-color-medium);
}

.sheet-body {
  padding: 4px var(--ion-padding, 16px) 16px;
}

.sheet-heading {
  flex: 1;
  min-width: 0;
}

/* Inset from the header's own box, so the distance from the top and from the
   side is the same number and not two boxes' paddings added together. */
.close-button {
  position: absolute;
  top: 16px;
  right: 8px;
  z-index: 11;
  width: 26px;
  height: 26px;
  min-height: 26px;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  --padding-start: 0;
  --padding-end: 0;
  --border-radius: 50%;
  --background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  --background-hover: var(--ion-color-step-150, rgba(0, 0, 0, 0.1));
  --color: var(--ion-color-medium, #777);
}

.close-button::part(native) {
  width: 26px;
  height: 26px;
  min-height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sheet-title {
  margin: 4px 0 2px;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
  /* Only the title runs alongside the close button, so only the title keeps
     clear of it. Reserving the gap on the whole header cut the meta line short
     under empty space. */
  padding-right: 36px;
}

.author {
  margin: 0;
  font-size: 14px;
  color: var(--ion-color-medium, #777);
}

/* One line, always. A long venue name would otherwise wrap and push the length
   onto a line of its own, which reads as a stray third fact. */
.meta {
  display: flex;
  align-items: baseline;
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--ion-color-medium, #777);
  white-space: nowrap;
  overflow: hidden;
}

.meta > span {
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta > span.shrinkable {
  flex: 0 1 auto;
  min-width: 3em;
}

/* Spaces inside `content` collapse between flex items, so the gap around the
   separator is set as padding rather than written into the string. */
.meta > span + span::before {
  content: "·";
  padding: 0 0.4em;
}

/* The mirror of the header: the list runs under the buttons and fades into
   them, so the hard rule that used to cap the scroll is gone. */
.sheet-actions {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 28px 16px calc(10px + var(--ion-safe-area-bottom, 0px));
  background: linear-gradient(
    to top,
    rgba(var(--lectorium-fade-bg-rgb), 1) 0%,
    rgba(var(--lectorium-fade-bg-rgb), 0.98) 60%,
    rgba(var(--lectorium-fade-bg-rgb), 0.6) 85%,
    rgba(var(--lectorium-fade-bg-rgb), 0) 100%
  );
}

/* Quiet destructive action in the same button stack — a user-added lecture can
   be taken out of the personal library from its own sheet. Matches the share
   button's soft chrome, tinted danger. */
.remove-btn {
  --background: rgba(var(--ion-color-danger-rgb), 0.1);
  --background-hover: rgba(var(--ion-color-danger-rgb), 0.16);
  --color: var(--ion-color-danger);
}

.act {
  position: relative;
  margin: 0;
  --padding-start: 0;
  --padding-end: 0;
  --box-shadow: none;
}

/* The two secondary actions are squares on the left; the primary one takes
   whatever is left of the row. */
.icon-act {
  flex: 0 0 auto;
  width: 48px;
}

.add-btn {
  flex: 1;
  min-width: 0;
}

.act [slot="start"] {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  margin: 0;
}

.share-btn {
  position: relative;
  /* Soft, light secondary button (no heavy outline) — sits quieter than the
     solid "add to playlist" primary action beside it. */
  --background: var(--ion-color-step-100, rgba(0, 0, 0, 0.05));
  --background-hover: var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
  --color: var(--ion-color-medium, #777);
}
</style>

<style>
/* The modal is teleported to the app root, so these host vars must be GLOBAL —
   scoped styles never reach the moved <ion-modal>. A fixed-height, bottom-
   anchored card: IonContent scrolls, IonFooter stays pinned to the bottom. */
ion-modal.track-sheet {
  --width: 100%;
  --height: 92%;
  --border-radius: 16px 16px 0 0;
  align-items: flex-end;
}

/* Ionic gives the footer a row of its own below the content; overlaying it is
   what lets the list run underneath and fade out. Anchored to this modal —
   a bare `ion-footer` selector here is global CSS and disables pointer events
   on every other footer in the app (#1534). */
ion-modal.track-sheet ion-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
  background: transparent;
  pointer-events: none;
}

ion-modal.track-sheet ion-footer .sheet-actions > * {
  pointer-events: auto;
}
</style>
