import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"

const libraryLanguages = ref<readonly LanguageCode[]>([])
const appLanguage = ref("en")
const loaded = ref(false)

vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => computed(() => libraryLanguages.value),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => appLanguage,
}))
vi.mock("@lectorium/stores/useSearchFiltersStore.js", () => ({
  useSearchFiltersStore: () => ({
    get loaded(): boolean {
      return loaded.value
    },
  }),
}))

const { useWantedTranscriptLanguages } = await import("../useWantedTranscriptLanguages.js")

describe("useWantedTranscriptLanguages", () => {
  beforeEach(() => {
    libraryLanguages.value = []
    appLanguage.value = "en"
    loaded.value = false
  })

  it("is the library languages plus the interface language", () => {
    libraryLanguages.value = ["ru"] as readonly LanguageCode[]
    appLanguage.value = "en"

    expect(useWantedTranscriptLanguages().languages.value).toEqual(["ru", "en"])
  })

  it("adds no duplicate when the interface language is already a library one", () => {
    libraryLanguages.value = ["en", "ru"] as readonly LanguageCode[]
    appLanguage.value = "ru"

    expect(useWantedTranscriptLanguages().languages.value).toEqual(["en", "ru"])
  })

  it("also carries the content language a UI-only locale reduces to", () => {
    // Ukrainian UI: no Ukrainian lectures exist, but its speaker reads ru.
    libraryLanguages.value = [] as readonly LanguageCode[]
    appLanguage.value = "uk"

    expect(useWantedTranscriptLanguages().languages.value).toEqual(["uk", "ru"])
  })

  it("is not ready until the persisted library selection has been read back", () => {
    const wanted = useWantedTranscriptLanguages()
    expect(wanted.ready.value).toBe(false)

    loaded.value = true

    expect(wanted.ready.value).toBe(true)
  })
})
