<template>
  <IonPage>
    <IonContent :scroll-y="false">
      <OnboardingCarousel
        v-model="page"
        :page-count="PAGE_COUNT"
        :primary-label="primaryLabel"
        :show-primary="page < PAGE_COUNT - 1"
        @primary="onPrimary"
        @skip="finish"
      >
        <template #slide="{ index }">
          <WelcomeScreen v-if="index === 0" />
          <TopicsScreen
            v-else-if="index === 1"
            :topics="topicOptions"
            v-model="selectedTopicIds"
          />
          <DailyWisdomScreen
            v-else-if="index === 2"
            :enabled="wisdomEnabled"
            :time="wisdomTime"
            @update:enabled="onWisdomEnabledChange"
            @update:time="wisdomTime = $event"
          />
          <ValueMomentScreen v-else-if="index === 3" :lectures="lectures" />
          <PaywallScreen v-else @done="finish" />
        </template>
      </OnboardingCarousel>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { IonContent, IonPage, useIonRouter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import {
  useOnboardingStore,
  ONBOARDING_INTERESTS_KEY,
} from "@shruti/stores/useOnboardingStore.js"
import { loadOnboardingTopics, type OnboardingTopicOption } from "./loadOnboardingTopics.js"
import OnboardingCarousel from "@ui/features/onboarding/OnboardingCarousel.vue"
import WelcomeScreen from "./screens/WelcomeScreen.vue"
import TopicsScreen from "./screens/TopicsScreen.vue"
import DailyWisdomScreen from "./screens/DailyWisdomScreen.vue"
import ValueMomentScreen, { type OnboardingLecture } from "./screens/ValueMomentScreen.vue"
import PaywallScreen from "./screens/PaywallScreen.vue"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"

const PAGE_COUNT = 5

const app = useShruti()
const ionRouter = useIonRouter()
const { t } = useI18n()
const appLanguage = useAppLanguage()
const filtersStore = useSearchFiltersStore()
const onboarding = useOnboardingStore()

const page = ref(0)
const topicOptions = ref<OnboardingTopicOption[]>([])
const selectedTopicIds = ref<string[]>([])
const lectures = ref<OnboardingLecture[]>([])

// Notification prefs the proactive daily-wisdom rule reads. Two-way bound, so
// a change persists immediately and the scheduler picks it up.
const wisdomEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
const wisdomTime = useConfig<[number, number]>("settings.notificationsTime", [9, 0])

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

// Load a few matched lectures once topics are known and the user reaches the
// value screen — keyed off the current selection (or the curated set).
watch(page, async (p) => {
  if (p === 3 && lectures.value.length === 0) {
    lectures.value = await loadValueLectures()
  }
})

async function loadValueLectures(): Promise<OnboardingLecture[]> {
  const seeds = (
    selectedTopicIds.value.length > 0
      ? selectedTopicIds.value
      : topicOptions.value.map((t) => t.id)
  ).slice(0, 1) as TopicId[]
  if (seeds.length === 0) return []
  const langs = filtersStore.languageCodes as readonly LanguageCode[]
  const repos = app.repositories()
  const trackIds = await repos.topics.topTrackIds(seeds[0], langs, 5)
  if (trackIds.length === 0) return []
  const byId = await repos.tracks.getByIds(trackIds)
  const lang = appLanguage.value
  const out: OnboardingLecture[] = []
  for (const id of trackIds) {
    const track = byId.get(id)
    if (!track) continue
    const variant = track.variants.find((v) => v.language === lang) ?? track.variants[0]
    if (variant?.title) out.push({ id, title: variant.title })
  }
  return out
}

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
</script>
