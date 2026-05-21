<template>
  <span
    role="button"
    tabindex="0"
    class="citation-chip"
    :class="{ 'is-loading': isPreparing, 'is-playing': isPlaying }"
    :style="chipStyle"
    :aria-label="ariaLabel"
    @click="onPrimary"
    @keydown.enter.space.prevent="onPrimary"
    @pointerdown="onPointerDown"
    @pointerup="onPointerCancel"
    @pointerleave="onPointerCancel"
    @pointercancel="onPointerCancel"
    @contextmenu.prevent="onOpenDetails"
  >
    <span class="chip-progress" aria-hidden="true" />
    <span class="chip-body">
      <span class="icon-slot" aria-hidden="true">
        <IonSpinner v-if="isPreparing" name="crescent" class="chip-spinner" />
        <IconPlayerPauseFilled v-else-if="isPlaying" :size="14" />
        <IconPlayerPlayFilled v-else :size="14" />
      </span>
      <span class="chip-title">{{ chipTitle }}</span>
      <button
        type="button"
        class="more-btn"
        :aria-label="$t('chat.citationDetailsTitle')"
        @click.stop="onOpenDetails"
      >
        <IconDots :size="12" stroke="2" />
      </button>
    </span>
    <audio
      ref="audioEl"
      preload="none"
      @ended="onEnded"
      @pause="onPause"
      @play="onPlay"
      @timeupdate="onTimeUpdate"
    />
    <IonActionSheet
      :is-open="actionSheetOpen"
      :header="actionSheetHeader"
      :buttons="actionSheetButtons"
      @did-dismiss="actionSheetOpen = false"
    />
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import router from "@shruti/router/index.js"
import { IonActionSheet, IonSpinner } from "@ionic/vue"
import { IconDots, IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { resolveTrackTitle } from "@shruti/composables/resolveLocalized.js"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useChatActions } from "@shruti/composables/useChatActions.js"
import { useToast } from "@shruti/services/useToast.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useStudioHandoffStore } from "@shruti/stores/useStudioHandoffStore.js"
import type { AuthorId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { Author } from "@lib/domain/author.js"
import { useCitationSnippet } from "../composables/useCitationSnippet.js"

/* -----------------------------------------------------------------------
 * Single-active coordinator (DOM-based)
 * -----------------------------------------------------------------------
 * Only one chip plays at a time. When the current chip's <audio> starts,
 * sweep the DOM and pause every OTHER `<audio>` inside a `.citation-chip`.
 * DOM-based instead of a module-scope pauser registry because:
 *   - Vue re-mounts chips on every streaming bubble update — a saved
 *     `pauseSelf` closure would point at a stale audioEl.
 *   - Vite HMR resets module-level state between edits.
 * Cost is microseconds even with hundreds of chips. */
function pauseOtherChipAudios(self: HTMLAudioElement | null): void {
  if (typeof document === "undefined") return
  const all = document.querySelectorAll<HTMLAudioElement>(".citation-chip audio")
  for (const el of all) {
    if (el !== self && !el.paused) el.pause()
  }
}

const props = defineProps<{
  trackId: string
  startMs: number
  endMs: number
  /** LLM-generated snippet caption from the marker. When present we
   *  show it in the chip; lecture title moves to the action sheet. */
  caption?: string
}>()

const { t } = useI18n()
// Singleton import — see NotesView.controller for the why.
const toast = useToast()
const app = useShruti()
const appLanguage = useAppLanguage()
const purchases = usePurchasesStore()
const paywall = usePaywallStore()
const studioHandoff = useStudioHandoffStore()
const { resolveUrl } = useCitationSnippet()
const { addToPlaylist } = useAddToPlaylist()
const { saveCitation } = useChatActions()

const audioEl = useTemplateRef<HTMLAudioElement>("audioEl")

const isPlaying = ref(false)
const isPreparing = ref(false)
const cachedUrl = ref<string | null>(null)
const actionSheetOpen = ref(false)
/** Guard so a second tap on "Save as note" while the transcript is still
 *  loading does NOT create a duplicate note. */
const savingNote = ref(false)
const progressPct = ref(0)

const chipStyle = computed(() => ({
  "--progress": `${progressPct.value}%`,
}))

const track = ref<Track | null>(null)
const author = ref<Author | null>(null)
const metaLoaded = ref(false)

// Long-press detection. The pointerdown handler arms a 500 ms timer;
// pointerup / leave / cancel disarms it. If the timer fires before
// disarm, we mark `suppressClick = true` so the trailing `click` event
// skips the play/pause toggle.
const LONG_PRESS_MS = 500
let pressTimer: ReturnType<typeof setTimeout> | null = null
let suppressClick = false

const lectureTitle = computed(() => {
  if (!track.value) return ""
  return resolveTrackTitle(track.value, appLanguage.value) ?? ""
})

const referenceLabel = computed<string>(() => {
  const refs = track.value?.references ?? []
  const first = refs[0]
  if (!first || !first.tokens || first.tokens.length === 0) return ""
  return first.tokens.join(".")
})

/**
 * Body of the chip: prefer the LLM-emitted snippet caption (what is
 * actually discussed in this fragment); fall back to the lecture title
 * when the marker omitted a caption. CSS truncates with ellipsis so we
 * pass the full string.
 */
const chipTitle = computed<string>(() => {
  const cap = props.caption?.trim()
  if (cap) return cap
  if (!metaLoaded.value) return "…"
  if (lectureTitle.value) return lectureTitle.value
  if (referenceLabel.value) return referenceLabel.value
  return t("chat.citationDetailsTitle")
})

const ariaLabel = computed(() => {
  if (isPreparing.value) return t("chat.citationLoading")
  return chipTitle.value
})

interface ChipActionSheetButton {
  readonly text: string
  readonly role?: "cancel" | "destructive"
  readonly handler: () => void
}

/** Header — lecture title only. The chip's caption already sits in the
 *  message body above, so duplicating it here was visual noise. */
const actionSheetHeader = computed(() => lectureTitle.value)

const actionSheetButtons = computed<readonly ChipActionSheetButton[]>(() => [
  {
    text: t("chat.citationSaveAsNote"),
    handler: (): void => {
      void onSaveAsNote()
    },
  },
  {
    text: t("chat.citationOpenInStudio"),
    handler: (): void => {
      void onOpenInStudio()
    },
  },
  {
    text: t("chat.citationAddLectureToPlaylist"),
    handler: (): void => {
      void onAddToPlaylist()
    },
  },
  {
    text: t("app.cancel"),
    role: "cancel",
    handler: (): void => undefined,
  },
])

async function onAddToPlaylist(): Promise<void> {
  try {
    await addToPlaylist(props.trackId)
    await toast.info(t("chat.citationAddedToPlaylist"))
  } catch (err) {
    console.warn("[citation-chip] add to playlist failed", err)
    await toast.error(t("chat.citationAddFailed"))
  }
}

/**
 * Open this citation in Studio (transient mode — no Note is created).
 * The citation payload is parked in `useStudioHandoffStore` and the
 * receiving controller consumes it on mount; Ionic's IonRouterOutlet
 * drops `history.state` when navigating out of a dismissing
 * IonActionSheet, so the store is the only reliable channel here.
 */
function onOpenInStudio(): void {
  if (!purchases.isSubscribed) {
    paywall.requestOpen()
    return
  }
  studioHandoff.setPending({
    kind: "citation",
    trackId: props.trackId,
    startMs: props.startMs,
    endMs: props.endMs,
    caption: props.caption ?? "",
  })
  void router.push("/tabs/studio")
}

async function onSaveAsNote(): Promise<void> {
  // Local reentrancy guard — local because it controls THIS chip's
  // disabled state, not a global "saving" notion. The transcript fetch
  // + overlap + createNote pipeline itself lives in saveCitation.
  if (savingNote.value) return
  savingNote.value = true
  try {
    await saveCitation({
      trackId: props.trackId,
      startMs: props.startMs,
      endMs: props.endMs,
      caption: props.caption ?? "",
    })
  } finally {
    savingNote.value = false
  }
}

async function loadMetadata(): Promise<void> {
  try {
    const repos = app.repositories()
    const t0 = await repos.tracks.getById(props.trackId as TrackId)
    track.value = t0 ?? null
    if (t0 && t0.authorId) {
      author.value = (await repos.authors.getById(t0.authorId as AuthorId)) ?? null
    } else {
      author.value = null
    }
  } catch (err) {
    console.warn("[citation-chip] metadata load failed", err)
  } finally {
    metaLoaded.value = true
  }
}

async function ensureUrl(): Promise<string | null> {
  if (cachedUrl.value) return cachedUrl.value
  try {
    const url = await resolveUrl({
      trackId: props.trackId,
      startMs: props.startMs,
      endMs: props.endMs,
    })
    cachedUrl.value = url
    return url
  } catch (err) {
    const code = (err as Error)?.message
    const ctx = {
      trackId: props.trackId,
      startMs: props.startMs,
      endMs: props.endMs,
    }
    if (code === "no-audio" || code === "track-not-found") {
      console.warn(`[citation-chip] ${code}`, ctx)
      await toast.error(t("chat.citationNoAudio"))
    } else {
      console.warn("[citation-chip] resolve failed", ctx, err)
      await toast.error(t("chat.citationLoadFailed"))
    }
    return null
  }
}

async function onPrimary(): Promise<void> {
  if (suppressClick) {
    suppressClick = false
    return
  }
  const el = audioEl.value
  if (!el) return
  if (isPlaying.value) {
    el.pause()
    return
  }
  if (!cachedUrl.value) {
    isPreparing.value = true
    try {
      const url = await ensureUrl()
      if (!url) return
      el.src = url
    } finally {
      isPreparing.value = false
    }
  } else if (!el.src) {
    el.src = cachedUrl.value
  }
  try {
    await el.play()
  } catch (err) {
    console.warn("[citation-chip] play failed", err)
  }
}

function onOpenDetails(): void {
  actionSheetOpen.value = true
}

function onPointerDown(): void {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    pressTimer = null
    suppressClick = true
    onOpenDetails()
  }, LONG_PRESS_MS)
}

function onPointerCancel(): void {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

function onPlay(): void {
  isPlaying.value = true
  pauseOtherChipAudios(audioEl.value)
}

function onPause(): void {
  isPlaying.value = false
}

function onEnded(): void {
  isPlaying.value = false
  const el = audioEl.value
  if (el) el.currentTime = 0
  progressPct.value = 0
}

function onTimeUpdate(): void {
  const el = audioEl.value
  if (!el) return
  const dur = el.duration
  if (!Number.isFinite(dur) || dur <= 0) return
  progressPct.value = Math.min(100, Math.max(0, (el.currentTime / dur) * 100))
}

watch(
  () => props.trackId,
  () => {
    track.value = null
    author.value = null
    metaLoaded.value = false
    void loadMetadata()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (pressTimer) clearTimeout(pressTimer)
  audioEl.value?.pause()
})
</script>

<style scoped>
/* Chip is a fixed-height pill — its height stays constant regardless of
 * whether metadata is still loading or whether playback is active, so the
 * surrounding text doesn't re-flow when several chips on the same page
 * settle into different states. */
.citation-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 22px;
  /* Vertical margin gives the chips breathing room when several wrap
     across lines — without it stacked rows of chips touch with no gap. */
  margin: 3px 2px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.45);
  background: rgba(var(--ion-color-primary-rgb), 0.18);
  color: var(--ion-color-primary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  vertical-align: middle;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
}

/* Progress fill: a sibling layer underneath the chip body. Visible
 * only while the chip is actively playing — once playback stops (pause,
 * end, or coordinator hand-off) we fade it out so all idle chips look
 * identical and the user doesn't see one mysteriously "filled" chip.
 * Width tracks `--progress` (0..100%) from audio.timeupdate. */
.chip-progress {
  position: absolute;
  inset: 0;
  width: var(--progress, 0%);
  background: rgba(var(--ion-color-primary-rgb), 0.28);
  transition:
    width 120ms linear,
    opacity 180ms ease;
  pointer-events: none;
  z-index: 0;
  opacity: 0;
}

.citation-chip.is-playing .chip-progress {
  opacity: 1;
}

.chip-body {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px 0 6px;
  height: 100%;
}

.citation-chip:active {
  background: rgba(var(--ion-color-primary-rgb), 0.18);
}

.citation-chip.is-loading {
  cursor: progress;
}

.icon-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.chip-spinner {
  --color: var(--ion-color-primary);
  width: 12px;
  height: 12px;
}

.chip-title {
  max-width: 14em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  border-radius: 50%;
  cursor: pointer;
  flex-shrink: 0;
  -webkit-tap-highlight-color: transparent;
}

.more-btn:active {
  opacity: 1;
  background: rgba(var(--ion-color-primary-rgb), 0.18);
}
</style>
