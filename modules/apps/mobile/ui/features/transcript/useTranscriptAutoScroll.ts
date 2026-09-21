import { nextTick, watch, type Ref } from "vue"
import {
  isAdjacentBlock,
  isDriftingOffBottom,
  isInViewport,
  isSeekTransient,
  scrollTargetTop,
} from "./transcriptScrollGeometry.js"

/**
 * Auto-scroll for the Pro "Automatic scroll" feature on the transcript dialog,
 * kept out of the dialog so that stays a presentational shell.
 *
 * Engagement is derived from visibility, not from input events: a cold open or
 * a seek always scrolls to the new active block, while a natural advance
 * scrolls only when the active block is on screen and drifting off the bottom.
 * Sampling `getBoundingClientRect()` at each active-block change avoids the
 * trackpad-inertia noise that `wheel`/`touchmove` listeners kept mistaking for
 * deliberate scrolling.
 *
 * Scrolls target `scrollEl` (IonContent's inner scroller) directly —
 * `scrollIntoView` moved two ancestor scroll contexts at once on this layout.
 */

// Smooth-scroll throttle (iOS WebKit fights queued animations).
const SCROLL_THROTTLE_MS = 400
// One transcript block, active or not. `TranscriptText` renders every group as
// a `<p class="prompter …">`; the active one additionally carries `.paragraph`.
// Anything else among the siblings — a chapter `<h2>` — is not a block.
const BLOCK_SELECTOR = "p.prompter"

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

  function isEngaged(el: HTMLElement): boolean {
    if (!scrollEl) return false
    const hostRect = scrollEl.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    return isInViewport(hostRect, elRect) && isDriftingOffBottom(hostRect, elRect)
  }

  function scrollToActive(el: HTMLElement): void {
    if (!scrollEl) return
    const now = Date.now()
    if (now - lastScrollAt < SCROLL_THROTTLE_MS) return
    const targetTop = scrollTargetTop(
      scrollEl.getBoundingClientRect(),
      el.getBoundingClientRect(),
      scrollEl.scrollTop
    )
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

    // The next emit carries the real target — skip this flip to the first block.
    if (isSeekTransient(prevPos, newPos)) return

    await nextTick()
    const active = scrollHost.querySelector(".transcript-text .paragraph") as HTMLElement | null
    if (!active || active === lastActiveEl) return
    const prev = lastActiveEl
    lastActiveEl = active

    // A natural block-to-block advance moves the viewport only for a reader who
    // is following along: on screen and approaching the lower edge. Off-screen
    // or scrolled ahead, the reader is somewhere else — leave them there.
    // A non-adjacent change is a seek, i.e. explicit intent, so it always wins.
    if (isAdjacentBlock(prev, active, BLOCK_SELECTOR) && !isEngaged(active)) return
    scrollToActive(active)
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
