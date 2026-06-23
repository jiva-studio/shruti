<template>
  <div
    class="status-pill"
    role="status"
    aria-live="polite"
    :style="tickerWidth !== null ? { '--ticker-width': tickerWidth + 'px' } : undefined"
  >
    <span class="spinner" aria-hidden="true"><slot name="spinner" /></span>
    <div class="ticker">
      <Transition name="ticker-slide">
        <span :key="currentItem" class="label visible">{{ currentItem }}</span>
      </Transition>
    </div>
    <!-- Off-screen measurement span. Lives OUTSIDE the .ticker grid so
         its width isn't bounded by the cell — otherwise scrollWidth
         would return the BOX width (last frame's grid cell) on a
         shrink, and the pill would only ever grow. Read its
         getBoundingClientRect().width after each currentItem change
         and pipe back into `--ticker-width`; CSS `transition: width`
         then smooths the change. iOS Safari 26.5 still lacks
         `interpolate-size: allow-keywords`, hence no CSS-only path. -->
    <span ref="measureEl" class="measure-probe" aria-hidden="true">{{ currentItem }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue"

/** Minimal shape this pill reads off a `research_source` event — just the
 *  display label. The full store type carries more (sourceKind etc.) the
 *  pure view never touches. */
interface ResearchSourceLabel {
  readonly label: string
}

/* -------------------------------------------------------------------------- */
/*  Props                                                                     */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  /** Already-localised status label — the parent (container) owns the i18n
   *  lookup of `chat.status.<key>`, so this component stays a pure view. */
  statusLabel?: string
  /** Live `research_question` events accumulated on the streaming bubble.
   *  Folded into the ticker pool so the user sees what's being explored. */
  researchQuestions?: readonly string[]
  /** Live `research_source` events keyed by id. Labels enter the pool. */
  researchSources?: ReadonlyMap<string, ResearchSourceLabel>
}>()

/* -------------------------------------------------------------------------- */
/*  Ticker pool                                                               */
/* -------------------------------------------------------------------------- */

const MAX_ITEM_CHARS = 56
const ROTATE_INTERVAL_MS = 1800

function trim(s: string): string {
  const v = s.trim().replace(/\s+/g, " ")
  if (v.length <= MAX_ITEM_CHARS) return v
  return v.slice(0, MAX_ITEM_CHARS - 1).trimEnd() + "…"
}

const statusLabel = computed(() => props.statusLabel ?? "")

// Combined pool: status label first (the "default" item), then research
// questions, then source labels. Source labels are already short-ish but
// trim is applied uniformly so the pill width stays bounded.
const pool = computed<readonly string[]>(() => {
  const out: string[] = []
  if (statusLabel.value) out.push(statusLabel.value)
  for (const q of props.researchQuestions ?? []) {
    const v = trim(q)
    if (v) out.push(v)
  }
  if (props.researchSources) {
    for (const src of props.researchSources.values()) {
      const v = trim(src.label || "")
      if (v) out.push(v)
    }
  }
  return out
})

/* -------------------------------------------------------------------------- */
/*  Rotation                                                                  */
/* -------------------------------------------------------------------------- */

// The visible string. We pick a random member of `pool` each tick,
// avoiding repeating the same item twice in a row when the pool has
// more than one entry — so the rotation feels alive rather than
// flickering on the same word.
const currentItem = ref<string>("")
let timer: ReturnType<typeof setTimeout> | null = null
// Tracks unmount so a pending timer that fires AFTER onBeforeUnmount
// (the recursive `setTimeout` can race with HMR / route transitions)
// doesn't mutate `currentItem` on a torn-down instance — Vue then
// throws `Cannot read properties of null (reading 'emitsOptions')`
// inside `patchKeyedChildren` and breaks reactivity on the whole app
// (computed properties like `floatingPlayerHidden` stop updating).
let isLive = true

function pickNext(): string {
  const items = pool.value
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  // Random non-repeating pick.
  let next = items[Math.floor(Math.random() * items.length)]
  let guard = 0
  while (next === currentItem.value && guard < 5) {
    next = items[Math.floor(Math.random() * items.length)]
    guard += 1
  }
  return next
}

function stopTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function scheduleNext(): void {
  stopTimer()
  if (!isLive) return
  if (pool.value.length <= 1) return
  timer = setTimeout(() => {
    if (!isLive) return
    currentItem.value = pickNext()
    scheduleNext()
  }, ROTATE_INTERVAL_MS)
}

// React to status changes: anchor the displayed text on the new status
// label immediately (so the pill doesn't feel stuck on a research item
// when the server moves on to `composing_answer`).
watch(
  () => statusLabel.value,
  (label) => {
    if (label) {
      currentItem.value = label
      scheduleNext()
    }
  },
  { immediate: true }
)

// React to pool growth: if the timer wasn't running (single-item pool
// at startup), kick it as soon as we have something to rotate to.
// `currentItem` is always populated by the status-label watcher above
// (immediate + fallback to "thinking" in `statusLabel`), so we only
// need to (re)start the timer here.
watch(
  () => pool.value.length,
  (n) => {
    if (n > 1 && timer === null) scheduleNext()
  }
)

/* -------------------------------------------------------------------------- */
/*  Animated width                                                            */
/* -------------------------------------------------------------------------- */

// Off-screen measurement span. After each currentItem change we read
// its rendered width (via getBoundingClientRect for fractional
// precision — Math.ceil rounds up so we don't lose the last sub-pixel
// to an ellipsis on the visible label). The value drives the
// `--ticker-width` CSS variable on the pill; CSS `transition: width`
// smooths the change. The probe sits OUTSIDE `.ticker` so it isn't
// constrained by the grid cell — scrollWidth on an in-grid element
// returns the BOX width (i.e. the previous frame's cell size) when
// content is shorter than the cell, which is why an earlier attempt
// here could only ever grow the pill.
const measureEl = useTemplateRef<HTMLSpanElement>("measureEl")
const tickerWidth = ref<number | null>(null)

watch(
  () => currentItem.value,
  () => {
    // `flush: "post"` already waits for the post-render flush, so the
    // probe span has the new text content when this fires — no extra
    // `await nextTick()` needed.
    if (measureEl.value) {
      tickerWidth.value = Math.ceil(measureEl.value.getBoundingClientRect().width)
    }
  },
  { immediate: true, flush: "post" }
)

onBeforeUnmount(() => {
  isLive = false
  stopTimer()
})
</script>

<style scoped>
.status-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--ion-color-step-50, rgba(0, 0, 0, 0.04));
  color: var(--ion-color-medium, #6b7280);
  font-size: 13px;
  line-height: 1.2;
  /* The explicit width via `--ticker-width` lets us animate between
   * label widths — `width: fit-content` would be ideal but Safari
   * (incl. iOS WKWebView used by Capacitor) still lacks
   * `interpolate-size: allow-keywords` as of 26.5, so no transition
   * fires between intrinsic-size keywords. We measure the label
   * scrollWidth in JS and pipe it back as a CSS variable; the +50px
   * is spinner (18) + gap (8) + horizontal padding (12×2). */
  width: calc(var(--ticker-width, 70px) + 50px);
  max-width: min(78vw, 320px);
  transition: width 280ms ease;
}
.spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: currentColor;
  flex-shrink: 0;
}
.spinner :deep(*) {
  width: 100%;
  height: 100%;
}
/* Ticker viewport — overflow-hidden window the labels slide through.
 * Uses CSS grid stacking so the enter/leave siblings during a
 * <Transition> swap occupy the SAME cell (overlap), without the
 * labels needing position:absolute. */
.ticker {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  flex: 1 1 auto;
  min-width: 0;
  height: 1.2em;
  overflow: hidden;
}
.label {
  grid-column: 1;
  grid-row: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Off-screen measurement probe. Positioned absolutely so it doesn't
 * affect the flex/grid layout and isn't constrained by any cell —
 * its `getBoundingClientRect().width` is the natural text width.
 * Inherits font properties from the pill so the measurement matches
 * the visible label's rendered metrics. */
.measure-probe {
  position: absolute;
  left: -9999px;
  top: -9999px;
  visibility: hidden;
  pointer-events: none;
  white-space: nowrap;
  font: inherit;
}
.ticker-slide-enter-active,
.ticker-slide-leave-active {
  transition:
    transform 320ms ease,
    opacity 320ms ease;
}
.ticker-slide-enter-from {
  transform: translateY(100%);
  opacity: 0;
}
.ticker-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
