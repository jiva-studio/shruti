<script setup lang="ts">
import { computed, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet, IonSpinner } from "@ionic/vue"
import { IconDots, IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useCitationActions } from "../composables/useCitationActions.js"
import { useCitationAudio } from "../composables/useCitationAudio.js"
import { useCitationChipUrl } from "../composables/useCitationChipUrl.js"
import { useLongPress } from "../composables/useLongPress.js"

const props = defineProps<{
  trackId: string
  startMs: number
  endMs: number
  /** Snippet caption from the marker; with one, the lecture title moves to
   *  the action sheet. */
  caption?: string
}>()

const { t } = useI18n()
const audioEl = useTemplateRef<HTMLAudioElement>("audioEl")

const ensureUrl = useCitationChipUrl(() => ({
  trackId: props.trackId,
  startMs: props.startMs,
  endMs: props.endMs,
}))

// Metadata and the action sheet are shared with the block CitationCard; the
// chip keeps its inline display, audio and long-press.
const { track, metaLoaded, trackTitle, actionSheetOpen, actionSheetButtons, openActions } =
  useCitationActions(() => ({
    trackId: props.trackId,
    startMs: props.startMs,
    endMs: props.endMs,
    caption: props.caption,
  }))

// The playback engine — orchestrator claim, spinner state, progress, stall
// watchdog, media handlers — is its own composable; it calls `ensureUrl`
// (hoisted) to resolve the excerpt URL on first play.
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

const { onPointerDown, onPointerCancel, takeSuppressedClick } = useLongPress(() => openActions())

const referenceLabel = computed<string>(() => {
  const refs = track.value?.references ?? []
  const first = refs[0]
  if (!first || !first.tokens || first.tokens.length === 0) return ""
  return first.tokens.join(".")
})

/** The snippet caption when the marker carried one — it says what this
 *  fragment is about — else the lecture title. CSS truncates it. */
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

/** A long press has already opened the action sheet, so its trailing click
 *  must not also toggle play. */
async function onPrimary(): Promise<void> {
  if (takeSuppressedClick()) return
  await toggle()
}
</script>

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

<style scoped>
/* A fixed-height pill whatever its state, so the surrounding text does not
 * re-flow as chips settle. */
.citation-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 22px;
  /* Vertical margin so wrapped rows of chips do not touch. */
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

/* A layer under the chip body, width tracking `--progress`. Faded out unless
 * playing, so every idle chip looks the same. */
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
