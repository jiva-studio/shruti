import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from "vue"
import { useIonRouter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import {
  useSubscriptionBinding,
  type SubscriptionBinding,
} from "@lectorium/views/Settings/composables/useSubscriptionBinding.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useSearchFiltersStore } from "@lectorium/stores/useSearchFiltersStore.js"
import {
  useOnboardingStore,
  ONBOARDING_INTERESTS_KEY,
} from "@lectorium/stores/useOnboardingStore.js"
import { loadOnboardingTopics, type OnboardingTopicOption } from "./loadOnboardingTopics.js"
import type { LanguageCode } from "@lib/domain/core.js"

export const PAGE_COUNT = 5
// Topics picker; once the user advances past it the value screen starts
// seeding + prefetching the matched lectures.
export const TOPICS_PAGE = 1

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
  finish: () => Promise<void>
}

export function useOnboardingViewController(): OnboardingViewBinding {
  const app = useLectorium()
  const ionRouter = useIonRouter()
  const { t } = useI18n()
  const appLanguage = useAppLanguage()
  const filtersStore = useSearchFiltersStore()
  const onboarding = useOnboardingStore()
  const subscription = useSubscriptionBinding()

  const page = ref(0)
  const topicOptions = ref<OnboardingTopicOption[]>([])
  const selectedTopicIds = ref<string[]>([])

  // Notification prefs the proactive daily-wisdom rule reads. Two-way bound, so
  // a change persists immediately and the scheduler picks it up.
  const wisdomEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const wisdomTime = useConfig<[number, number]>("settings.notificationsTime", [9, 0])

  const primaryLabel = computed(() => {
    if (page.value === 0) return t("onboarding.welcome.cta")
    if (page.value === PAGE_COUNT - 1) return t("onboarding.finish")
    return t("onboarding.continue")
  })

  // A successful purchase on the paywall completes onboarding.
  watch(
    () => subscription.isSubscribed,
    (now, was) => {
      if (now && !was) void finish()
    }
  )

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
    if (page.value === 1) await persistTopics()
    if (page.value < PAGE_COUNT - 1) {
      page.value += 1
      return
    }
    await finish()
  }

  async function persistTopics(): Promise<void> {
    const ids = selectedTopicIds.value
    await filtersStore.setTopics(ids).catch(() => undefined)
    await app.preferences.set(ONBOARDING_INTERESTS_KEY, JSON.stringify(ids)).catch(() => undefined)
  }

  async function finish(): Promise<void> {
    // Persist picks even on skip from a later page, so a partial run still
    // personalizes Home.
    await persistTopics()
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
    finish,
  }
}
