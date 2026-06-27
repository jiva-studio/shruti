import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { useIonRouter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import {
  useSubscriptionBinding,
  type SubscriptionBinding,
} from "@shruti/views/Settings/composables/useSubscriptionBinding.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import { useOnboardingStore } from "@shruti/stores/useOnboardingStore.js"
import { loadOnboardingTopics, type OnboardingTopicOption } from "./loadOnboardingTopics.js"
import type { LanguageCode } from "@lib/domain/core.js"

export type OnboardingPageId = "welcome" | "topics" | "dailyWisdom" | "valueMoment" | "paywall"

interface OnboardingPageMeta {
  id: OnboardingPageId
  /** Whether this page is part of the flow for the current build. The
   *  paywall is dropped in the off-store build (no in-app purchase —
   *  subscriptions are managed on the website). */
  enabled: boolean
}

// Ordered onboarding flow. Inclusion lives on the page itself, so the count
// and the rendered sequence both derive from this list — no magic indices.
const ALL_PAGES: readonly OnboardingPageMeta[] = [
  { id: "welcome", enabled: true },
  { id: "topics", enabled: true },
  { id: "dailyWisdom", enabled: true },
  { id: "valueMoment", enabled: true },
  // Paywall temporarily hidden — onboarding now finishes on the last
  // content page (valueMoment). Was: enabled: !__OFFSTORE_BUILD__
  { id: "paywall", enabled: false },
]

/** The active pages for this build, in order. The view renders by `id`. */
export const PAGES: readonly OnboardingPageId[] = ALL_PAGES.filter((p) => p.enabled).map(
  (p) => p.id
)
export const PAGE_COUNT = PAGES.length
// Topics picker; once the user advances past it the value screen starts
// seeding + prefetching the matched lectures.
export const TOPICS_PAGE = PAGES.indexOf("topics")

export interface OnboardingViewBinding {
  readonly subscription: SubscriptionBinding
  readonly page: Ref<number>
  readonly topicOptions: Ref<OnboardingTopicOption[]>
  readonly selectedTopicIds: Ref<string[]>
  readonly wisdomEnabled: Ref<boolean>
  readonly wisdomTime: Ref<[number, number]>
  readonly primaryLabel: ComputedRef<string>
  onWisdomEnabledChange: (value: boolean) => Promise<void>
  onPrimary: () => Promise<void>
  onSubscribe: (packageId: string) => Promise<void>
  onRestore: () => Promise<void>
  finish: () => Promise<void>
}

export function useOnboardingViewController(): OnboardingViewBinding {
  const app = useShruti()
  const ionRouter = useIonRouter()
  const { t } = useI18n()
  const appLanguage = useAppLanguage()
  const filtersStore = useSearchFiltersStore()
  const onboarding = useOnboardingStore()
  const subscription = useSubscriptionBinding()

  const page = ref(0)
  const topicOptions = ref<OnboardingTopicOption[]>([])
  const selectedTopicIds = ref<string[]>([])

  // Onboarding-local choice. Applied to the real settings only on finish, so
  // the proactive scheduler (which reads settings.notifications*) doesn't fire a
  // wisdom message mid-onboarding. The OS permission is still requested live.
  const wisdomEnabled = ref(false)
  const wisdomTime = ref<[number, number]>([9, 0])
  const notificationsEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const notificationsTime = useConfig<[number, number]>("settings.notificationsTime", [9, 0])

  const primaryLabel = computed(() => {
    if (page.value === 0) return t("onboarding.welcome.cta")
    if (page.value === PAGE_COUNT - 1) return t("onboarding.finish")
    return t("onboarding.continue")
  })

  onMounted(async () => {
    await filtersStore.load().catch(() => undefined)
    try {
      topicOptions.value = await loadOnboardingTopics(
        app.repositories(),
        appLanguage.value as LanguageCode,
        filtersStore.languageCodes as readonly LanguageCode[]
      )
    } catch (err) {
      console.warn("[onboarding] topic load failed", err)
    }
  })

  async function onWisdomEnabledChange(value: boolean): Promise<void> {
    wisdomEnabled.value = value
    if (value) {
      // Best-effort OS permission request; the toggle stays on even if denied
      // (the message still appears in chat next open — see the daily-wisdom rule).
      await app.notifications.requestPermission().catch(() => undefined)
    }
  }

  async function onPrimary(): Promise<void> {
    if (page.value === TOPICS_PAGE) await persistTopics()
    if (page.value < PAGE_COUNT - 1) {
      page.value += 1
      return
    }
    await finish()
  }

  async function persistTopics(): Promise<void> {
    // The picked topics personalize the library (search filters). They are NOT
    // saved as daily-wisdom interests: daily wisdom draws a random fragment
    // from the whole corpus, not the user's topics.
    await filtersStore.setTopics(selectedTopicIds.value).catch(() => undefined)
  }

  // The onboarding paywall always offers to buy (never Manage). A successful
  // purchase or restore ends onboarding the same way Skip does; a cancel /
  // "nothing to restore" leaves the user on the paywall to decide.
  async function onSubscribe(packageId: string): Promise<void> {
    await subscription.onSubscribe(packageId)
    if (subscription.isSubscribed) await finish()
  }

  async function onRestore(): Promise<void> {
    await subscription.onRestore()
    if (subscription.isSubscribed) await finish()
  }

  async function finish(): Promise<void> {
    // Persist picks even on skip from a later page, so a partial run still
    // personalizes Home.
    await persistTopics()
    // Apply the daily-wisdom choice now — after this, the scheduler may fire.
    notificationsTime.value = wisdomTime.value
    notificationsEnabled.value = wisdomEnabled.value
    await onboarding.markCompleted()
    ionRouter.replace("/tabs/home")
  }

  return {
    subscription,
    page,
    topicOptions,
    selectedTopicIds,
    wisdomEnabled,
    wisdomTime,
    primaryLabel,
    onWisdomEnabledChange,
    onPrimary,
    onSubscribe,
    onRestore,
    finish,
  }
}
