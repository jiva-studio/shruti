import { nextTick, watch, type Ref } from "vue"

/**
 * Auto-scroll machinery for the Pro "Automatic scroll" feature on the
 * transcript dialog. Extracted from TranscriptDialog.vue so the dialog
 * stays a presentational shell — this file owns the visibility-derived
 * engagement model that decides when to follow playback.
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

export interface UseTranscriptAutoScrollOptions {
  /** Template ref to the IonContent (or any host whose `$el` exposes
   *  `getScrollElement()` and the active-block subtree). */
  readonly contentRef: Ref<{ $el: HTMLElement } | undefined | null>
  /** Whether the dialog is open. Drives teardown on close. */
  readonly open: Ref<boolean>
  /** Live playback position in ms. Watched for active-block changes. */
  readonly position: () => number
  /** Pro-gated toggle. Off → no scrolling; mid-session flip handled. */
  readonly autoScroll: () => boolean
}

export interface UseTranscriptAutoScrollReturn {
  /** Hook into the modal's `@didPresent`. Attaches the machinery + does
   *  the cold-open scroll. */
  readonly onModalPresented: () => Promise<void>
}

export function useTranscriptAutoScroll(
  opts: UseTranscriptAutoScrollOptions
): UseTranscriptAutoScrollReturn {
  let scrollHost: HTMLElement | null = null
  let scrollEl: HTMLElement | null = null
  let lastActiveEl: HTMLElement | null = null
  let lastScrollAt = 0
  let lastSeenPosition = 0
  let detachWindowFocus: (() => void) | null = null

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

  function onWindowFocus(): void {
    // When the browser tab regains focus, IonModal's focus trap (or the
    // browser itself) may re-focus the first focusable element in the
    // modal and auto-scroll the viewport to it — usually the close
    // button at the top, which yanks us to scrollTop=0 instantly. Wait
    // for the focus-driven scroll to settle (two frames), then re-snap
    // to whatever the current active block is.
    if (!opts.autoScroll() || !opts.open.value || !lastActiveEl) return
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
    if (!opts.autoScroll()) return
    const ionContent = opts.contentRef.value
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

  // Position-driven follow.
  watch(opts.position, async () => {
    const newPos = opts.position()
    const prevPos = lastSeenPosition
    lastSeenPosition = newPos
    if (!opts.autoScroll() || !opts.open.value || !scrollHost) return

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
  })

  watch(opts.open, (next) => {
    if (next) return
    teardownAutoScroll()
  })

  // Mid-session toggle. On → attach machinery only (no cold-open
  // re-scroll: an unrelated reactive flip shouldn't yank the viewport).
  // Off → teardown.
  watch(opts.autoScroll, (enabled) => {
    if (!opts.open.value) return
    if (enabled) void attachMachinery()
    else teardownAutoScroll()
  })

  return { onModalPresented }
}
