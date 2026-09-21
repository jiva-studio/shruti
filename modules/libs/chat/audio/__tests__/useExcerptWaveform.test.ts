// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, h, nextTick, ref, type Ref } from "vue"
import {
  useExcerptWaveform,
  type ExcerptRefSource,
  type UseExcerptWaveformOptions,
  type UseExcerptWaveformReturn,
} from "../useExcerptWaveform.js"

/** Module caches are keyed by noteId and outlive a test, so every case
 *  invents its own note. */
let noteCounter = 0
function freshNote(): string {
  noteCounter += 1
  return `note-${noteCounter}-${Math.random().toString(36).slice(2)}`
}

const CDN = "https://cdn.test/shares/audio"

interface Mounted {
  waveform: UseExcerptWaveformReturn
  rootEl: Ref<HTMLElement | null>
  unmount: () => void
}

function mountWaveform(
  refSource: ExcerptRefSource,
  overrides: Partial<UseExcerptWaveformOptions> = {}
): Mounted {
  const rootEl = ref<HTMLElement | null>(document.createElement("div"))
  const waveformEl = ref<HTMLElement | null>(document.createElement("div"))
  let waveform!: UseExcerptWaveformReturn
  const app = createApp({
    setup() {
      waveform = useExcerptWaveform({
        ref: refSource,
        rootEl,
        waveformEl,
        cut: async ({ excerptId }) => ({ url: `${CDN}/${excerptId}.mp3`, ready: true }),
        predictUrl: (noteId) => `${CDN}/${noteId}.mp3`,
        ...overrides,
      })
      return () => h("div")
    },
  })
  app.mount(document.createElement("div"))
  return { waveform, rootEl, unmount: () => app.unmount() }
}

/** A mono buffer whose second half is at full scale and first half silent. */
function halfLoudPcm(length = 800): Float32Array {
  const data = new Float32Array(length)
  for (let i = length / 2; i < length; i++) data[i] = 1
  return data
}

// The composable caches one AudioContext for the whole module, so the class is
// fixed and the buffer a test wants to decode is swapped underneath it.
let nextChannel: () => Float32Array = halfLoudPcm

class FakeAudioContext {
  async decodeAudioData(): Promise<{ getChannelData: () => Float32Array }> {
    return { getChannelData: () => nextChannel() }
  }
}

function stubAudioContext(channel: () => Float32Array): void {
  nextChannel = channel
  ;(window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  stubAudioContext(halfLoudPcm)
})

afterEach(() => {
  warn.mockRestore()
  vi.unstubAllGlobals()
})

/** Let the mount-time decode attempt run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick()
}

describe("useExcerptWaveform — placeholder bars", () => {
  it("paints a seeded placeholder before anything is decoded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const noteId = freshNote()
    const { waveform } = mountWaveform({ noteId, sourceKey: "s", timeStart: 0, timeEnd: 1000 })
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(false)
    expect(waveform.peaks.value).toHaveLength(64)
    for (const h of waveform.peaks.value) {
      expect(h).toBeGreaterThanOrEqual(4)
      expect(h).toBeLessThanOrEqual(98)
    }
  })

  it("gives two notes different placeholder shapes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const a = mountWaveform({ noteId: freshNote(), sourceKey: "s", timeStart: 0, timeEnd: 1 })
    const b = mountWaveform({ noteId: freshNote(), sourceKey: "s", timeStart: 0, timeEnd: 1 })
    await settle()

    expect(a.waveform.peaks.value).not.toEqual(b.waveform.peaks.value)
  })
})

describe("useExcerptWaveform — url resolution", () => {
  it("has no url before the excerpt is cut", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const noteId = freshNote()
    const { waveform } = mountWaveform({ noteId, sourceKey: "s", timeStart: 0, timeEnd: 1 })
    await settle()

    expect(waveform.cachedUrl()).toBeNull()
    expect(waveform.predictedExcerptUrl()).toBe(`${CDN}/${noteId}.mp3`)
  })

  it("cuts once and answers from the cache afterwards", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const noteId = freshNote()
    let call = 0
    const { waveform } = mountWaveform(
      { noteId, sourceKey: "s", timeStart: 0, timeEnd: 1 },
      {
        cut: async () => {
          call += 1
          return { url: `${CDN}/cut-${call}.mp3`, ready: true }
        },
      }
    )
    await settle()

    expect(await waveform.resolveExcerptUrl()).toBe(`${CDN}/cut-1.mp3`)
    expect(await waveform.resolveExcerptUrl()).toBe(`${CDN}/cut-1.mp3`)
    expect(waveform.cachedUrl()).toBe(`${CDN}/cut-1.mp3`)
  })

  it("falls back to the predicted url when the cutter returns none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const noteId = freshNote()
    const { waveform } = mountWaveform(
      { noteId, sourceKey: "s", timeStart: 0, timeEnd: 1 },
      { cut: async () => ({ url: "", ready: true }) }
    )
    await settle()

    expect(await waveform.resolveExcerptUrl()).toBe(`${CDN}/${noteId}.mp3`)
  })

  it("waits for an excerpt the server is still generating", async () => {
    let head = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "HEAD") {
          head += 1
          return { ok: head > 1, status: head > 1 ? 200 : 404 }
        }
        return { ok: false, status: 404 }
      })
    )
    const noteId = freshNote()
    const { waveform } = mountWaveform(
      { noteId, sourceKey: "s", timeStart: 0, timeEnd: 1 },
      { cut: async () => ({ url: `${CDN}/${noteId}.mp3`, ready: false }) }
    )
    await settle()

    const url = await waveform.resolveExcerptUrl()

    expect(url).toBe(`${CDN}/${noteId}.mp3`)
    expect(head).toBeGreaterThan(1)
  }, 20000)

  it("reads a rebuilt ref fresh, so a late source key reaches the cutter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const noteId = freshNote()
    const sourceKey = ref("")
    const { waveform } = mountWaveform(
      () => ({ noteId, sourceKey: sourceKey.value, timeStart: 10, timeEnd: 20 }),
      { cut: async ({ sourceKey: key }) => ({ url: `${CDN}/by-${key}.mp3`, ready: true }) }
    )
    await settle()

    sourceKey.value = "tracks/abc.mp3"

    expect(await waveform.resolveExcerptUrl()).toBe(`${CDN}/by-tracks/abc.mp3.mp3`)
  })
})

describe("useExcerptWaveform — decoding real peaks", () => {
  it("replaces the placeholder with the decoded shape once the excerpt is on the cdn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    )
    const noteId = freshNote()
    const { waveform } = mountWaveform({ noteId, sourceKey: "s", timeStart: 0, timeEnd: 1 })
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(true)
    expect(waveform.peaks.value).toHaveLength(64)
    // The buffer is silent for its first half and full-scale for the second.
    expect(waveform.peaks.value[0]).toBe(5)
    expect(waveform.peaks.value[63]).toBe(100)
  })

  it("floors a silent excerpt at a visible bar instead of a flat line", async () => {
    stubAudioContext(() => new Float32Array(800))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    )
    const { waveform } = mountWaveform({
      noteId: freshNote(),
      sourceKey: "s",
      timeStart: 0,
      timeEnd: 1,
    })
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(true)
    expect(new Set(waveform.peaks.value)).toEqual(new Set([5]))
  })

  it("keeps the placeholder when the excerpt is not on the cdn yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const { waveform } = mountWaveform({
      noteId: freshNote(),
      sourceKey: "s",
      timeStart: 0,
      timeEnd: 1,
    })
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(false)
  })

  it("keeps the placeholder when the decode throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => {
          throw new Error("connection reset")
        },
      }))
    )
    const { waveform } = mountWaveform({
      noteId: freshNote(),
      sourceKey: "s",
      timeStart: 0,
      timeEnd: 1,
    })
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(false)
  })

  it("re-hydrates decoded peaks for a note that was decoded earlier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    )
    const noteId = freshNote()
    const first = mountWaveform({ noteId, sourceKey: "s", timeStart: 0, timeEnd: 1 })
    await settle()
    const decoded = [...first.waveform.peaks.value]
    first.unmount()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    )
    const second = mountWaveform({ noteId, sourceKey: "s", timeStart: 0, timeEnd: 1 })

    expect(second.waveform.hasRealPeaks.value).toBe(true)
    expect(second.waveform.peaks.value).toEqual(decoded)
  })

  it("decodes nothing while the row is off-screen", async () => {
    const observed: Array<(entries: unknown[]) => void> = []
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: unknown[]) => void) {
          observed.push(cb)
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    )
    const { waveform } = mountWaveform({
      noteId: freshNote(),
      sourceKey: "s",
      timeStart: 0,
      timeEnd: 1,
    })
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(false)

    observed[0]([{ isIntersecting: true }])
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(true)
  })

  it("decodes on scroll-in when the observer reports the row visible", async () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        cb: (entries: unknown[]) => void
        constructor(cb: (entries: unknown[]) => void) {
          this.cb = cb
        }
        observe(): void {
          this.cb([{ isIntersecting: true }])
        }
        disconnect(): void {}
      }
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    )
    const { waveform } = mountWaveform({
      noteId: freshNote(),
      sourceKey: "s",
      timeStart: 0,
      timeEnd: 1,
    })
    await settle()

    expect(waveform.hasRealPeaks.value).toBe(true)
  })
})
