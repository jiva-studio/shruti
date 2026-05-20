<template>
  <IonModal
    :is-open="open"
    class="transcript-dialog"
    @did-present="onModalPresented"
    @did-dismiss="open = false"
  >
    <IonContent ref="contentRef">
      <IonButton
        class="close-button"
        fill="clear"
        size="small"
        tabindex="-1"
        :aria-label="$t('app.close')"
        @click="emit('close')"
      >
        <IconXFilled slot="icon-only" :size="20" />
      </IonButton>

      <TranscriptDialogHeader :title="title" :author="author" />

      <LanguageSelector
        v-if="availableLanguages.length > 1"
        v-model:active="activeLanguages"
        :languages="availableLanguages"
        :allow-multiple="allowMultipleLanguages"
      />

      <TranscriptStatus
        :state="statusState"
        :error-message="errorMessage"
        :empty-message="$t('transcript.noneAvailable')"
        :loading-message="$t('transcript.loading')"
      />
      <TranscriptText
        v-if="statusState === null"
        ref="transcriptText"
        class="transcript-text"
        :groups="blockGroups"
        :position="position"
        :duration="duration"
        :display-speaker-icons="allowMultipleLanguages"
        :should-highlight-current-sentence="
          enableActiveProminence !== false && shouldHighlightCurrentSentence
        "
        :enable-active-prominence="enableActiveProminence !== false"
        @seek="(pos) => emit('seek', pos)"
        @text-selected="onTextSelected"
        @note-tapped="onNoteTapped"
        @pick-start="emit('pickStart')"
      />

      <TranscriptSelectionPopover
        :selection="lastTextSelectedEvent"
        :existing="lastNoteTappedEvent"
        @action="onSelectionAction"
        @dismissed="onSelectionDismissed"
      />

      <SpeakerFloatingChip />
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue"
import { IonButton, IonContent, IonModal } from "@ionic/vue"
import { IconXFilled } from "@tabler/icons-vue"
import LanguageSelector from "./LanguageSelector.vue"
import SpeakerFloatingChip from "./SpeakerFloatingChip.vue"
import TranscriptDialogHeader from "./TranscriptDialogHeader.vue"
import TranscriptStatus from "./TranscriptStatus.vue"
import TranscriptSelectionPopover, {
  type SelectionAction,
  type ExistingNoteSelection,
} from "./TranscriptSelectionPopover.vue"
import TranscriptText, { type TextSelectedEvent, type NoteTappedEvent } from "./TranscriptText.vue"
import type { UiTranscriptBlocksGroup, UiTranscriptLanguage } from "./types.js"

export type SelectionActionEvent = Pick<TextSelectedEvent, "timeStart" | "timeEnd" | "text"> & {
  action: SelectionAction
  /** Set when the action is `"delete"` (tap-on-highlight path); empty
   *  array otherwise. The controller uses this to drive the notes-store
   *  remove call. */
  noteIds: readonly string[]
}

const props = defineProps<{
  blockGroups: readonly UiTranscriptBlocksGroup[]
  availableLanguages: readonly UiTranscriptLanguage[]
  title: string
  author: string
  position: number
  duration: number
  allowMultipleLanguages: boolean
  shouldHighlightCurrentSentence: boolean
  /**
   * Pro-gated continuous-follow flag. When true, the dialog scrolls to
   * the active paragraph on cold-open AND keeps it in view during
   * playback (lazy-follow: scrolls only when the active block is about
   * to leave the viewport). When false, no auto-scroll happens — the
   * user scrolls manually. The parent AND-gates this on subscription
   * status and `mirrorsActivePlayer` (no live position → no follow).
   */
  autoScroll?: boolean
  /** True while the transcript is being fetched. Shows a spinner. */
  isLoading?: boolean
  /** Non-null when the transcript fetch failed. Shows the error text. */
  errorMessage?: string | null
  /** True after hydration when the track has no advertised transcripts. */
  hasNoTranscripts?: boolean
  /**
   * When false, the active-paragraph prompter effect (scale-up of the
   * current group, scale-down + fade of the rest) is suppressed. Use
   * for preview-style opens where the dialog isn't tied to live
   * playback and `position` stays at 0.
   */
  enableActiveProminence?: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  selectionAction: [action: SelectionActionEvent]
  selectionDismissed: []
  /** Long-press on a selectable block — controller fires platform haptics. */
  pickStart: []
  /** User tapped the explicit close button (top-right corner). */
  close: []
}>()

const open = defineModel<boolean>("open", { default: false, required: true })
const activeLanguages = defineModel<string[]>("activeLanguages", {
  default: [] as string[],
  required: true,
})

const statusState = computed<"loading" | "error" | "empty" | null>(() => {
  if (props.isLoading) return "loading"
  if (props.errorMessage) return "error"
  if (props.hasNoTranscripts) return "empty"
  return null
})

const lastTextSelectedEvent = ref<TextSelectedEvent>()
/**
 * Mirrors `lastTextSelectedEvent` for the tap-on-highlight path. Setting
 * this drives the popover into `mode="existing"` (Copy/Share/Delete);
 * clearing it closes the popover, same lifecycle as a drag-select event.
 * Kept separate from `lastTextSelectedEvent` so the two flows stay
 * orthogonal — opening one always clears the other.
 */
const lastNoteTappedEvent = ref<ExistingNoteSelection>()
const transcriptText = useTemplateRef<{ clearSelection: () => void }>("transcriptText")
const contentRef = useTemplateRef<{ $el: HTMLElement }>("contentRef")

/**
 * Auto-scroll machinery for the Pro "Automatic scroll" feature.
 *
 * Model: **visibility-derived engagement**, no input listeners.
 *
 *  - **Cold-open** + **seek/jump** (non-adjacent active change):
 *    force-scroll to the new active block. The user has explicitly
 *    asked to be there — either by opening the transcript or by
 *    pressing skip — so we move them.
 *
 *  - **Natural playback advance** (active block became the
 *    next-sibling block of the previous one): scroll only if the
 *    user is **engaged**, i.e. the active block is currently visible
 *    in the scroll viewport. If it's off-screen, the user is reading
 *    elsewhere — don't yank them back. Engagement is rechecked at
 *    every active-block change, so the moment the user scrolls back
 *    to where playback is, follow re-engages automatically on the
 *    next block transition.
 *
 *  - **Seek-transient guard**: native players sometimes emit
 *    `progress ≈ 0` mid-seek between the old position and the real
 *    target. We skip such position changes entirely so the active
 *    class never flips to the first block.
 *
 * No `wheel`/`touchmove` listeners. They were the source of repeated
 * pause-on-trackpad-inertia bugs: macOS trackpads fire a long tail of
 * small `deltaY` wheel events after the user stops, which is
 * indistinguishable from real scroll input. Deriving engagement from
 * the active block's DOM-visibility at active-change time sidesteps
 * the whole class of input-event noise.
 *
 * No `IntersectionObserver`. Visibility is computed synchronously
 * from `getBoundingClientRect()` at each active-block change — that
 * single sample is all the engagement signal we need.
 *
 * All scrolls target `scrollEl` (the inner-scroll element returned by
 * `IonContent.getScrollElement()`) directly via `scrollTo` with a
 * computed target. `Element.scrollIntoView` was scrolling two
 * ancestor scroll contexts in tandem on this layout, which the user
 * saw as a double motion.
 */

// ---- Constants --------------------------------------------------------

// Smooth-scroll throttle (iOS WebKit fights queued animations).
const SCROLL_THROTTLE_MS = 400
// Bottom comfort band as a fraction of host height. On natural
// block-to-block transitions we scroll only when the active block's
// bottom drifts past this line. Keep this high so the active block
// has room to drift well into the lower portion of the viewport
// before we re-snap it back to the top — premature scrolling feels
// jumpy and forces the reader to keep refocusing.
const BOTTOM_BAND = 0.9
// Where the block lands when we *do* scroll — just a small gap from
// the top of the visible area so the reader sees mostly upcoming
// content, not previously-read context. Teleprompter style.
const UPPER_OFFSET_FRACTION = 0.1
// Position-drop heuristic for the seek-transient guard.
const TRANSIENT_NEAR_ZERO_MS = 500
const TRANSIENT_PREV_MIN_MS = 1000

// ---- State ------------------------------------------------------------

let scrollHost: HTMLElement | null = null
let scrollEl: HTMLElement | null = null
let lastActiveEl: HTMLElement | null = null
let lastScrollAt = 0
let lastSeenPosition = 0
let detachWindowFocus: (() => void) | null = null

// ---- Helpers ----------------------------------------------------------

function isInViewport(el: HTMLElement): boolean {
  if (!scrollEl) return false
  const hostRect = scrollEl.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  return elRect.bottom > hostRect.top && elRect.top < hostRect.bottom
}

function isDriftingOffBottom(el: HTMLElement): boolean {
  if (!scrollEl) return false
  const hostRect = scrollEl.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const bottomRel = (elRect.bottom - hostRect.top) / hostRect.height
  return bottomRel > BOTTOM_BAND
}

function isAdjacentBlock(prev: HTMLElement | null, next: HTMLElement): boolean {
  if (!prev) return false
  return prev.nextElementSibling === next
}

function scrollToActive(el: HTMLElement): void {
  if (!scrollEl) return
  const now = Date.now()
  if (now - lastScrollAt < SCROLL_THROTTLE_MS) return
  const hostRect = scrollEl.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const upperOffset = hostRect.height * UPPER_OFFSET_FRACTION
  const elTopInScroll = elRect.top - hostRect.top + scrollEl.scrollTop
  const targetTop = Math.max(0, elTopInScroll - upperOffset)
  scrollEl.scrollTo({ top: targetTop, behavior: "smooth" })
  lastScrollAt = now
}

// ---- Lifecycle --------------------------------------------------------

function onWindowFocus(): void {
  // When the browser tab regains focus, IonModal's focus trap (or the
  // browser itself) may re-focus the first focusable element in the
  // modal and auto-scroll the viewport to it — usually the close
  // button at the top, which yanks us to scrollTop=0 instantly. Wait
  // for the focus-driven scroll to settle (two frames), then re-snap
  // to whatever the current active block is.
  if (!props.autoScroll || !open.value || !lastActiveEl) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!lastActiveEl) return
      // Bypass throttle — focus-return needs an immediate correction.
      lastScrollAt = 0
      scrollToActive(lastActiveEl)
    })
  })
}

async function attachMachinery(): Promise<void> {
  if (scrollHost) return // already attached
  if (!props.autoScroll) return
  const ionContent = contentRef.value
  if (!ionContent) return
  scrollHost = ionContent.$el as HTMLElement
  if (!scrollHost) return
  window.addEventListener("focus", onWindowFocus)
  detachWindowFocus = () => window.removeEventListener("focus", onWindowFocus)
  // ion-content's `getScrollElement()` lives on the web-component DOM
  // node (`$el`), NOT on Vue's component wrapper. Calling it on the
  // wrapper returns undefined and we end up with `scrollEl ===
  // ion-content` — which isn't itself scrollable, so `scrollTo()` is
  // a no-op. Resolve via $el; fall back to a DOM query for the
  // `.inner-scroll` div (older / non-shadow Ionic builds).
  const ionEl = scrollHost as unknown as {
    getScrollElement?: () => Promise<HTMLElement>
  }
  let inner: HTMLElement | undefined
  if (typeof ionEl.getScrollElement === "function") {
    inner = await ionEl.getScrollElement()
  }
  if (!inner) {
    inner = (scrollHost.querySelector(".inner-scroll") as HTMLElement | null) ?? undefined
  }
  scrollEl = inner ?? scrollHost
}

async function performColdOpen(): Promise<void> {
  if (!scrollHost) return
  // Let IonModal's auto-focus / focus-trap settle first. Without this
  // wait the browser's "scroll focused element into view" kicks in
  // *after* our cold-open scroll and snaps the viewport back to the
  // first focusable child (the close-button, which lives at the top).
  await nextTick()
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  const active = scrollHost.querySelector(".transcript-text .paragraph") as HTMLElement | null
  if (!active) return
  scrollToActive(active)
  lastActiveEl = active
}

function teardownAutoScroll(): void {
  detachWindowFocus?.()
  detachWindowFocus = null
  scrollHost = null
  scrollEl = null
  lastActiveEl = null
  lastScrollAt = 0
  lastSeenPosition = 0
}

async function onModalPresented(): Promise<void> {
  await attachMachinery()
  await performColdOpen()
}

// ---- Position-driven follow ------------------------------------------

watch(
  () => props.position,
  async () => {
    const newPos = props.position
    const prevPos = lastSeenPosition
    lastSeenPosition = newPos
    if (!props.autoScroll || !open.value || !scrollHost) return

    // Seek-transient guard. The next emit carries the real target —
    // skip this active-class flip to the first block.
    const isTransientNearZero =
      newPos < TRANSIENT_NEAR_ZERO_MS && prevPos - newPos > TRANSIENT_PREV_MIN_MS
    if (isTransientNearZero) return

    await nextTick()
    const active = scrollHost.querySelector(".transcript-text .paragraph") as HTMLElement | null
    if (!active || active === lastActiveEl) return
    const prev = lastActiveEl
    lastActiveEl = active

    if (isAdjacentBlock(prev, active)) {
      // Natural block-to-block transition. Scroll only when the active
      // block has drifted past the bottom comfort band — i.e. it's
      // visible *and* approaching the lower edge. Three cases we
      // intentionally leave alone:
      //   - active off-screen entirely: user is reading elsewhere;
      //   - active above the upper band: user scrolled forward past
      //     where playback is and is reading upcoming content — don't
      //     yank them back;
      //   - active in the comfort zone: comfortable, no need to move.
      if (!isInViewport(active)) return
      if (!isDriftingOffBottom(active)) return
      scrollToActive(active)
    } else {
      // Non-adjacent: a seek or paragraph jump. Treat as an explicit
      // user intent and scroll to the new active regardless of
      // current viewport state. The transient guard above already
      // filters mid-seek `position = 0` flicker.
      scrollToActive(active)
    }
  }
)

watch(open, (next) => {
  if (next) return
  teardownAutoScroll()
})

// Mid-session toggle. On → attach machinery only (no cold-open
// re-scroll: an unrelated reactive flip shouldn't yank the viewport).
// Off → teardown.
watch(
  () => props.autoScroll,
  (enabled) => {
    if (!open.value) return
    if (enabled) void attachMachinery()
    else teardownAutoScroll()
  }
)

function onTextSelected(event: TextSelectedEvent): void {
  lastNoteTappedEvent.value = undefined
  lastTextSelectedEvent.value = event
}

function onNoteTapped(event: NoteTappedEvent): void {
  lastTextSelectedEvent.value = undefined
  lastNoteTappedEvent.value = { noteIds: event.noteIds, event: event.event }
}

function onSelectionAction(payload: {
  action: SelectionAction
  text: string
  timeStart: number
  timeEnd: number
  noteIds: readonly string[]
}): void {
  emit("selectionAction", payload)
  lastTextSelectedEvent.value = undefined
  lastNoteTappedEvent.value = undefined
  transcriptText.value?.clearSelection()
}

function onSelectionDismissed(): void {
  lastTextSelectedEvent.value = undefined
  lastNoteTappedEvent.value = undefined
  transcriptText.value?.clearSelection()
  emit("selectionDismissed")
}
</script>

<style scoped>
ion-modal {
  --ion-background-color: var(--shruti-immersive-background);
  --ion-text-color: var(--shruti-immersive-text);
}

ion-modal ion-content {
  --background: var(--shruti-immersive-background);
}

ion-modal ion-toolbar {
  --background: var(--shruti-immersive-background);
}

.transcript-text {
  /* Justified edges + scale(1.01) on the active paragraph push glyphs
     past the screen sides without a horizontal gutter — IonContent has
     no default content padding here. */
  padding-inline: 16px;
  /* Floating player covers 56px */
  padding-bottom: 56px;
}

.transcript-dialog {
  /* Below FloatingPlayer (z-index: 999) so the legacy "tap player to
     close transcript" UX still works in player-mode. Below Ionic
     action-sheet/alert/loading/toast (~1001) so those still win when
     stacked over the dialog. */
  z-index: 500 !important;
}

.close-button {
  /* Pinned over the immersive content. The tap target sits inside the
     safe-area inset so it stays clear of the notch / status bar on
     both iOS and Android. */
  position: absolute;
  top: calc(env(safe-area-inset-top) + 4px);
  right: 4px;
  z-index: 1;
  --color: var(--shruti-immersive-text);
  --padding-start: 8px;
  --padding-end: 8px;
  margin: 0;
}
</style>
