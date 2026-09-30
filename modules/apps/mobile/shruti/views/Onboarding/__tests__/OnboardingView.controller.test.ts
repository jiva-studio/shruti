// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, ref, type App } from "vue"

const ctx = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>(),
  setTopics: vi.fn<(ids: string[]) => Promise<void>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  loadTopics: vi.fn(async () => []),
  reportError: vi.fn(),
}))

vi.mock("@ionic/vue", () => ({ useIonRouter: () => ({ replace: vi.fn() }) }))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@shruti/views/Settings/composables/useSubscriptionBinding.js", () => ({
  useSubscriptionBinding: () => ({ isSubscribed: false }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ notifications: { requestPermission: ctx.requestPermission } }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (_key: string, initial: unknown) => ref(initial),
}))
vi.mock("@shruti/stores/useSearchFiltersStore.js", () => ({
  useSearchFiltersStore: () => ({
    load: ctx.load,
    setTopics: ctx.setTopics,
    languageCodes: ["en"],
  }),
}))
vi.mock("@shruti/stores/useOnboardingStore.js", () => ({
  useOnboardingStore: () => ({ markCompleted: vi.fn(async () => {}) }),
}))
vi.mock("@shruti/wiring/onboardingUseCases.js", () => ({
  useOnboardingUseCases: () => ({ loadTopics: ctx.loadTopics }),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: ctx.reportError }))

import {
  TOPICS_PAGE,
  useOnboardingViewController,
  type OnboardingViewBinding,
} from "../OnboardingView.controller.js"

const boom = new Error("store unavailable")
let app: App | null = null

function mountController(): OnboardingViewBinding {
  let binding!: OnboardingViewBinding
  app = createApp({
    setup() {
      binding = useOnboardingViewController()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return binding
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  ctx.load.mockResolvedValue(undefined)
  ctx.setTopics.mockResolvedValue(undefined)
  ctx.requestPermission.mockResolvedValue("granted")
})

afterEach(() => {
  app?.unmount()
  app = null
})

describe("useOnboardingViewController — failures are reported and the flow goes on", () => {
  it("reports search filters that fail to load and still loads the topics", async () => {
    ctx.load.mockRejectedValueOnce(boom)
    mountController()
    await flush()

    expect(ctx.reportError).toHaveBeenCalledWith("onboarding", boom)
    expect(ctx.loadTopics).toHaveBeenCalledOnce()
  })

  it("reports a notification permission request that fails and keeps the toggle on", async () => {
    ctx.requestPermission.mockRejectedValueOnce(boom)
    const binding = mountController()
    await flush()

    await binding.onWisdomEnabledChange(true)

    expect(ctx.reportError).toHaveBeenCalledWith("onboarding", boom)
    expect(binding.wisdomEnabled.value).toBe(true)
  })

  it("reports picked topics that fail to save and moves to the next page", async () => {
    ctx.setTopics.mockRejectedValueOnce(boom)
    const binding = mountController()
    await flush()
    binding.page.value = TOPICS_PAGE

    await binding.onPrimary()

    expect(ctx.reportError).toHaveBeenCalledWith("onboarding", boom)
    expect(binding.page.value).toBe(TOPICS_PAGE + 1)
  })
})
