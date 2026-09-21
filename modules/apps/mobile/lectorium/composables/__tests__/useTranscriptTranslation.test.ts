import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { IngestGatewayError } from "@ports/app/ingest.js"

const TRACK_ID = "t1"
const POLL_INTERVAL_MS = 3000
const VARIANT_WAIT_MS = 90_000

interface Membership {
  id: string
  trackId: string
  titleRaw: string | null
  variants: { language: string }[]
}

const openTrackId = ref<string | null>(TRACK_ID)
const appLanguage = ref("en")
const libraryLanguages = ref<string[]>(["en", "de"])
const storedLanguages = ref<string[]>(["en"])
const libraryItems = ref<Membership[]>([])

const submit = vi.fn()
const status = vi.fn()
/** Track ids re-hydrated after a translated variant landed. */
let rehydrated: string[] = []
let syncRequests = 0
let paywallOpened = 0
const errors: string[] = []
const notices: string[] = []

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ ingestClient: { submit, status } }),
}))
vi.mock("@lectorium/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({
    get items() {
      return libraryItems.value
    },
  }),
}))
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({
    get trackId() {
      return openTrackId.value
    },
  }),
}))
vi.mock("@lectorium/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({
    requestOpen: () => {
      paywallOpened++
    },
  }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => appLanguage }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => libraryLanguages,
}))
vi.mock("@lectorium/services/syncEvents.js", () => ({
  requestSync: () => {
    syncRequests++
  },
}))

import { useTranscriptTranslation } from "../useTranscriptTranslation.js"

function membership(languages: string[]): Membership {
  return {
    id: "m1",
    trackId: TRACK_ID,
    titleRaw: "Original title",
    variants: languages.map((language) => ({ language })),
  }
}

function setup() {
  return useTranscriptTranslation({
    storedLanguages,
    onVariantArrived: async (trackId) => {
      rehydrated.push(trackId)
    },
    onError: (key) => errors.push(key),
    onNotice: (key) => notices.push(key),
  })
}

/** Let the run reach its first poll and answer it. */
async function firstPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
}

describe("useTranscriptTranslation", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    submit.mockReset()
    status.mockReset()
    submit.mockResolvedValue({ run_id: "run-1" })
    status.mockResolvedValue({ state: "ready" })
    openTrackId.value = TRACK_ID
    appLanguage.value = "en"
    libraryLanguages.value = ["en", "de"]
    storedLanguages.value = ["en"]
    libraryItems.value = [membership(["en"])]
    rehydrated = []
    syncRequests = 0
    paywallOpened = 0
    errors.length = 0
    notices.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("a run that produced a variant", () => {
    it("pulls it down and re-reads the track once it has synced in", async () => {
      const translation = setup()

      const done = translation.translate("de")
      await firstPoll()
      expect(rehydrated).toEqual([])
      expect(syncRequests).toBe(1)

      libraryItems.value = [membership(["en", "de"])]
      await done

      expect(rehydrated).toEqual([TRACK_ID])
      expect(translation.running.value.has("de")).toBe(false)
    })

    it("re-reads immediately when the variant is already there", async () => {
      const translation = setup()
      libraryItems.value = [membership(["en", "de"])]

      const done = translation.translate("de")
      await firstPoll()
      await done

      expect(rehydrated).toEqual([TRACK_ID])
    })

    it("sends the source language, the membership and the source title", async () => {
      const translation = setup()
      libraryItems.value = [membership(["en", "de"])]

      const done = translation.translate("de")
      await firstPoll()
      await done

      expect(submit).toHaveBeenCalledWith({
        op: "translate",
        membership_id: "m1",
        track: TRACK_ID,
        source_lang: "en",
        target_lang: "de",
        title: "Original title",
      })
    })

    it("re-reads anyway when the variant never syncs in", async () => {
      const translation = setup()

      const done = translation.translate("de")
      await firstPoll()
      await vi.advanceTimersByTimeAsync(VARIANT_WAIT_MS - 1)
      expect(rehydrated).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      await done

      expect(rehydrated).toEqual([TRACK_ID])
    })

    it("leaves a track the user has since closed alone", async () => {
      const translation = setup()

      const done = translation.translate("de")
      openTrackId.value = "t2"
      await firstPoll()
      await done

      expect(syncRequests).toBe(0)
      expect(rehydrated).toEqual([])
    })
  })

  describe("while a run is in flight", () => {
    it("marks only the requested language as running", async () => {
      libraryLanguages.value = ["en", "de", "ru"]
      status.mockResolvedValue({ state: "running" })
      const translation = setup()

      const done = translation.translate("de")
      await Promise.resolve()

      expect([...translation.running.value]).toEqual(["de"])

      await vi.advanceTimersByTimeAsync(120 * POLL_INTERVAL_MS)
      await done
      expect([...translation.running.value]).toEqual([])
    })

    it("refuses a second run for the same language", async () => {
      status.mockResolvedValue({ state: "running" })
      const translation = setup()

      const first = translation.translate("de")
      await Promise.resolve()
      await translation.translate("de")

      expect(submit).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(120 * POLL_INTERVAL_MS)
      await first
    })
  })

  describe("a run the server refused", () => {
    it("opens the paywall instead of reporting a failure when the user is not PRO", async () => {
      submit.mockRejectedValue(new IngestGatewayError(402, "pro required", "not_pro"))
      const translation = setup()

      await translation.translate("de")

      expect(paywallOpened).toBe(1)
      expect(errors).toEqual([])
      expect(translation.running.value.has("de")).toBe(false)
    })

    it("reports a failure for any other refusal", async () => {
      submit.mockRejectedValue(new IngestGatewayError(500, "ingest api responded 500"))
      const translation = setup()

      await translation.translate("de")

      expect(paywallOpened).toBe(0)
      expect(errors).toEqual(["errors.translationFailed"])
    })
  })

  describe("a run that produced nothing", () => {
    it("reports a failed run as an error", async () => {
      status.mockResolvedValue({ state: "failed" })
      const translation = setup()

      const done = translation.translate("de")
      await firstPoll()
      await done

      expect(errors).toEqual(["errors.translationFailed"])
      expect(rehydrated).toEqual([])
      expect(syncRequests).toBe(0)
    })

    it("keeps polling through a transient status failure", async () => {
      status.mockRejectedValueOnce(new Error("offline"))
      status.mockResolvedValue({ state: "ready" })
      libraryItems.value = [membership(["en", "de"])]
      const translation = setup()

      const done = translation.translate("de")
      await firstPoll()
      expect(rehydrated).toEqual([])

      await firstPoll()
      await done

      expect(rehydrated).toEqual([TRACK_ID])
    })
  })

  describe("what may be requested", () => {
    it("ignores a language that is not on offer", async () => {
      const translation = setup()

      await translation.translate("fr")

      expect(submit).not.toHaveBeenCalled()
    })

    it("ignores a request on a catalog lecture", async () => {
      libraryItems.value = []
      const translation = setup()

      await translation.translate("de")

      expect(submit).not.toHaveBeenCalled()
    })
  })
})
