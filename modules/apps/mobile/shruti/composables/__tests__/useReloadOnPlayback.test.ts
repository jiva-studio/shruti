// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, ref, type Ref } from "vue"
import { useReloadOnPlayback } from "../useReloadOnPlayback.js"

/**
 * The minute-by-minute poll that keeps a surface's session-derived data fresh
 * during a long listen — and its off-screen switch.
 *
 * Ionic hides but never unmounts a tab page, so without the switch Home kept
 * reloading the heatmap every 60s behind Search or Chat for the entire
 * duration of playback: a DB read and a re-render a minute for a widget
 * nobody could see (issue #1615).
 */

const INTERVAL = 1000

/** Run the composable inside a component, the way a view does. */
function host(playing: Ref<boolean>, onScreen?: Ref<boolean>): { unmount: () => void } {
  const app = createApp(
    defineComponent({
      setup() {
        useReloadOnPlayback(playing, reload, INTERVAL, onScreen)
        return () => h("div")
      },
    })
  )
  app.mount(document.createElement("div"))
  return { unmount: () => app.unmount() }
}

let reload: ReturnType<typeof vi.fn<() => void>>

describe("useReloadOnPlayback", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reload = vi.fn<() => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("polls while playing and stops the moment the page leaves the screen", async () => {
    const playing = ref(true)
    const onScreen = ref(true)
    const app = host(playing, onScreen)

    // One immediate load on the playing edge, then the poll.
    expect(reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(INTERVAL * 2)
    expect(reload).toHaveBeenCalledTimes(3)

    onScreen.value = false
    await nextTick()
    reload.mockClear()

    // A whole lecture plays out on another tab and nothing here reads a thing.
    vi.advanceTimersByTime(INTERVAL * 60)
    expect(reload).not.toHaveBeenCalled()

    onScreen.value = true
    await nextTick()
    vi.advanceTimersByTime(INTERVAL)

    // Back on screen the poll resumes — the view reloads once on entry itself,
    // so returning does not need a reload of its own.
    expect(reload).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it("does not start polling for playback that begins off-screen", async () => {
    const playing = ref(false)
    const onScreen = ref(false)
    const app = host(playing, onScreen)

    playing.value = true
    await nextTick()
    vi.advanceTimersByTime(INTERVAL * 10)

    // The playing-edge reload still lands (it costs one read and keeps the
    // surface correct for the next time it is shown); the poll does not.
    expect(reload).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it("polls unconditionally when no switch is supplied", async () => {
    const playing = ref(true)
    const app = host(playing)

    vi.advanceTimersByTime(INTERVAL * 2)

    expect(reload).toHaveBeenCalledTimes(3)
    app.unmount()
  })

  it("stops polling on pause and on unmount", async () => {
    const playing = ref(true)
    const onScreen = ref(true)
    const app = host(playing, onScreen)
    reload.mockClear()

    playing.value = false
    await nextTick()
    // The stopped edge reloads once, then goes quiet.
    expect(reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(INTERVAL * 5)
    expect(reload).toHaveBeenCalledTimes(1)

    playing.value = true
    await nextTick()
    app.unmount()
    reload.mockClear()
    vi.advanceTimersByTime(INTERVAL * 5)
    expect(reload).not.toHaveBeenCalled()
  })
})
