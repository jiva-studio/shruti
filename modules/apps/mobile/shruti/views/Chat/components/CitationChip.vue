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
    @contextmenu.prevent="openActions"
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
        @click.stop="openActions"
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
      @playing="onPlaying"
      @canplay="onCanPlay"
      @waiting="onWaiting"
      @stalled="onWaiting"
      @error="onError"
      @timeupdate="onTimeUpdate"
    />
    <IonActionSheet
      :is-open="actionSheetOpen"
      :header="trackTitle"
      :buttons="actionSheetButtons"
      @did-dismiss="actionSheetOpen = false"
    />
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet, IonSpinner } from "@ionic/vue"
import { IconDots, IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useCitationActions } from "../composables/useCitationActions.js"
import { useCitationAudio } from "../composables/useCitationAudio.js"
import { useToast } from "@kit/composables"
import { useCachedExcerptUrl } from "@shruti/composables/useCachedExcerptUrl.js"
import { useCitationSnippet } from "../composables/useCitationSnippet.js"

const props = defineProps<{
  trackId: string
  startMs: number
  endMs: number
  /** LLM-generated snippet caption from the marker. When present we
   *  show it in the chip; lecture title moves to the action sheet. */
  caption?: string
}>()

const { t } = useI18n()
const toast = useToast()
const { resolveUrl } = useCitationSnippet()
const { resolve: resolveCachedUrl } = useCachedExcerptUrl()
const audioEl = useTemplateRef<HTMLAudioElement>("audioEl")

const cachedUrl = ref<string | null>(null)

// Metadata + the Save/Studio/Playlist action sheet are shared with the block
// CitationCard. The chip keeps only its inline display + audio + long-press.
const { track, metaLoaded, trackTitle, actionSheetOpen, actionSheetButtons, openActions } =
  useCitationActions(() => ({
    trackId: props.trackId,
    startMs: props.startMs,
    endMs: props.endMs,
    caption: props.caption,
  }))

// The audio-playback engine (orchestrator claim, spinner state, progress,
// stall watchdog, media-event handlers) lives in its own composable. It calls
// `ensureUrl` (declared below; hoisted) to lazily resolve the excerpt URL on
// first play. The returned handlers are bound by name in the template.
const {
  isPlaying,
  isPreparing,
  progressPct,
  toggle,
  onPlay,
  onPlaying,
  onCanPlay,
  onWaiting,
  onError,
  onPause,
  onEnded,
  onTimeUpdate,
} = useCitationAudio({ audioEl, resolveUrl: ensureUrl })

const chipStyle = computed(() => ({
  "--progress": `${progressPct.value}%`,
}))

// Long-press detection. The pointerdown handler arms a 500 ms timer;
// pointerup / leave / cancel disarms it. If the timer fires before
// disarm, we mark `suppressClick = true` so the trailing `click` event
// skips the play/pause toggle.
const LONG_PRESS_MS = 500
let pressTimer: ReturnType<typeof setTimeout> | null = null
let suppressClick = false

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
  if (trackTitle.value) return trackTitle.value
  if (referenceLabel.value) return referenceLabel.value
  return t("chat.citationDetailsTitle")
})

const ariaLabel = computed(() => {
  if (isPreparing.value) return t("chat.citationLoading")
  return chipTitle.value
})

async function ensureUrl(): Promise<string | null> {
  if (cachedUrl.value) return cachedUrl.value
  const snippetRef = { trackId: props.trackId, startMs: props.startMs, endMs: props.endMs }
  try {
    const url = await resolveCachedUrl(() => resolveUrl(snippetRef))
    cachedUrl.value = url
    return url
  } catch (err) {
    const code = (err as Error)?.message
    const ctx = snippetRef
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

/** Primary tap: a long-press already opened the action sheet (and set
 *  `suppressClick`), so swallow the trailing click; otherwise toggle play. */
async function onPrimary(): Promise<void> {
  if (suppressClick) {
    suppressClick = false
    return
  }
  await toggle()
}

function onPointerDown(): void {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    pressTimer = null
    suppressClick = true
    openActions()
  }, LONG_PRESS_MS)
}

function onPointerCancel(): void {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

onBeforeUnmount(() => {
  // Audio cleanup (timer + pause) is owned by useCitationAudio; here we only
  // disarm the long-press gesture timer.
  if (pressTimer) clearTimeout(pressTimer)
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
</style>
