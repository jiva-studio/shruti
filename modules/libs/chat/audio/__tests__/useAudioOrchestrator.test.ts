// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h } from "vue"
import { pauseGroup, registerAudioSource, useAudioSource } from "../useAudioOrchestrator.js"

function mountSource(
  kind: "main" | "inline",
  pause: () => void
): {
  claim: () => void
  unmount: () => void
} {
  let claim!: () => void
  const app = createApp({
    setup() {
      claim = useAudioSource(kind, pause).claim
      return () => h("div")
    },
  })
  app.mount(document.createElement("div"))
  return { claim: () => claim(), unmount: () => app.unmount() }
}

describe("audio orchestrator", () => {
  it("pauses every other source, of either kind, when one claims", () => {
    const paused: string[] = []
    const inline = registerAudioSource("inline", () => paused.push("inline"))
    const other = registerAudioSource("inline", () => paused.push("other"))
    const main = registerAudioSource("main", () => paused.push("main"))

    inline.claim()

    expect(paused).toEqual(["other", "main"])

    inline.release()
    other.release()
    main.release()
  })

  it("leaves the claiming source alone", () => {
    const paused: string[] = []
    const self = registerAudioSource("inline", () => paused.push("self"))

    self.claim()

    expect(paused).toEqual([])
    self.release()
  })

  it("pauses only the named kind on pauseGroup", () => {
    const paused: string[] = []
    const inline = registerAudioSource("inline", () => paused.push("inline"))
    const main = registerAudioSource("main", () => paused.push("main"))

    pauseGroup("inline")

    expect(paused).toEqual(["inline"])
    inline.release()
    main.release()
  })

  it("stops reaching a released source", () => {
    const paused: string[] = []
    const gone = registerAudioSource("inline", () => paused.push("gone"))
    const live = registerAudioSource("inline", () => paused.push("live"))

    gone.release()
    pauseGroup("inline")

    expect(paused).toEqual(["live"])
    live.release()
  })

  it("keeps pausing the rest when one source throws", () => {
    const paused: string[] = []
    const broken = registerAudioSource("inline", () => {
      throw new Error("element detached")
    })
    const after = registerAudioSource("inline", () => paused.push("after"))
    const claimer = registerAudioSource("inline", () => paused.push("claimer"))

    expect(() => claimer.claim()).not.toThrow()
    expect(paused).toEqual(["after"])

    broken.release()
    after.release()
    claimer.release()
  })

  it("releases a component source on unmount", () => {
    const paused: string[] = []
    const component = mountSource("inline", () => paused.push("component"))
    const outsider = registerAudioSource("inline", () => paused.push("outsider"))

    component.unmount()
    pauseGroup("inline")

    expect(paused).toEqual(["outsider"])
    outsider.release()
  })

  it("lets a mounted component pause the lecture", () => {
    const paused: string[] = []
    const main = registerAudioSource("main", () => paused.push("main"))
    const component = mountSource("inline", () => paused.push("component"))

    component.claim()

    expect(paused).toEqual(["main"])
    component.unmount()
    main.release()
  })
})
