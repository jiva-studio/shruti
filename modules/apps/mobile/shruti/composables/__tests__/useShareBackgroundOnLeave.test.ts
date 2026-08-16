import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, type Ref } from "vue"

// #1886: the share slot is app-wide and single, so a job with no on-screen
// trace makes every other share refuse for a reason the user cannot see. The
// surfaces that never block the UI — Studio's video render, the chat share-PDF
// card — had no way to say "still working"; leaving them is the moment that
// has to light the tab indicator.

const { state, markInBackground } = vi.hoisted(() => ({
  state: { running: false },
  markInBackground: vi.fn(),
}))

vi.mock("@shruti/router/index.js", async () => {
  const { ref } = await vi.importActual<typeof import("vue")>("vue")
  return { default: { currentRoute: ref({ fullPath: "/tabs/studio" }) } }
})
vi.mock("@shruti/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({
    markInBackground,
    get isRunning() {
      return state.running
    },
  }),
}))

import router from "@shruti/router/index.js"
import { useShareBackgroundOnLeave } from "../useShareBackgroundOnLeave.js"

const currentRoute = router.currentRoute as unknown as Ref<{ fullPath: string }>

describe("useShareBackgroundOnLeave", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentRoute.value = { fullPath: "/tabs/studio" }
    state.running = false
  })

  it("marks a running job as backgrounded when the surface is navigated away from", async () => {
    state.running = true
    useShareBackgroundOnLeave()

    currentRoute.value = { fullPath: "/tabs/notes" }
    await nextTick()

    expect(markInBackground).toHaveBeenCalledTimes(1)
  })

  it("stays silent when no share is running", async () => {
    useShareBackgroundOnLeave()

    currentRoute.value = { fullPath: "/tabs/notes" }
    await nextTick()

    expect(markInBackground).not.toHaveBeenCalled()
  })

  it("does not fire while the user stays on the surface", async () => {
    state.running = true
    useShareBackgroundOnLeave()

    await nextTick()

    expect(markInBackground).not.toHaveBeenCalled()
  })
})
