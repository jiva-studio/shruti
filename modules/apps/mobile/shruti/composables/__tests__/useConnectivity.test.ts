// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type Ref } from "vue"
import { useConnectivity } from "../useConnectivity.js"

let added: string[] = []
let removed: string[] = []

function spyOnConnectivityListeners(): void {
  const origAdd = window.addEventListener.bind(window)
  const origRemove = window.removeEventListener.bind(window)
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "online" || type === "offline") added.push(type)
    origAdd(type, listener as EventListener, options)
  })
  vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "online" || type === "offline") removed.push(type)
    origRemove(type, listener as EventListener, options)
  })
}

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true })
}

interface Harness {
  offlineFlags: Readonly<Ref<boolean>>[]
  unmount: () => void
}

/** Mount `count` sibling components, each of which calls the composable. */
function mountConsumers(count: number, onReconnect?: () => void): Harness {
  const offlineFlags: Readonly<Ref<boolean>>[] = []
  const Consumer = defineComponent({
    setup() {
      // A fresh closure per consumer — the singleton keys subscribers by
      // identity, so sharing one function reference would dedupe them.
      const { isOffline } = useConnectivity(onReconnect ? { onReconnect: () => onReconnect() } : {})
      offlineFlags.push(isOffline)
      return () => h("div")
    },
  })
  const Host = defineComponent({
    setup() {
      return () =>
        h(
          "div",
          Array.from({ length: count }, (_, i) => h(Consumer, { key: i }))
        )
    },
  })
  const app = createApp(Host)
  app.mount(document.createElement("div"))
  return { offlineFlags, unmount: () => app.unmount() }
}

describe("useConnectivity", () => {
  beforeEach(() => {
    added = []
    removed = []
    setOnLine(true)
    spyOnConnectivityListeners()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("registers one listener pair no matter how many consumers mount", () => {
    const many = mountConsumers(50)
    expect(added.filter((t) => t === "online")).toHaveLength(1)
    expect(added.filter((t) => t === "offline")).toHaveLength(1)
    many.unmount()
  })

  it("detaches the listeners once the last consumer unmounts, and re-attaches after", () => {
    const first = mountConsumers(3)
    first.unmount()
    expect(removed.filter((t) => t === "online")).toHaveLength(1)
    expect(removed.filter((t) => t === "offline")).toHaveLength(1)

    added = []
    const second = mountConsumers(1)
    expect(added).toEqual(expect.arrayContaining(["online", "offline"]))
    second.unmount()
  })

  it("shares one reactive flag across consumers", () => {
    const { offlineFlags, unmount } = mountConsumers(4)
    expect(offlineFlags.every((f) => f.value === false)).toBe(true)

    setOnLine(false)
    window.dispatchEvent(new Event("offline"))
    expect(offlineFlags.every((f) => f.value === true)).toBe(true)

    setOnLine(true)
    window.dispatchEvent(new Event("online"))
    expect(offlineFlags.every((f) => f.value === false)).toBe(true)
    unmount()
  })

  it("re-samples navigator.onLine when the first consumer mounts", () => {
    setOnLine(false)
    const { offlineFlags, unmount } = mountConsumers(1)
    expect(offlineFlags[0].value).toBe(true)
    unmount()
  })

  it("notifies every subscriber on reconnect and stops after unmount", () => {
    const onReconnect = vi.fn()
    const { unmount } = mountConsumers(2, onReconnect)

    window.dispatchEvent(new Event("online"))
    expect(onReconnect).toHaveBeenCalledTimes(2)

    unmount()
    onReconnect.mockClear()
    window.dispatchEvent(new Event("online"))
    expect(onReconnect).not.toHaveBeenCalled()
  })
})
