<template>
  <IonPage>
    <IonContent :scroll-y="false">
      <OnboardingCarousel
        v-model="page"
        :page-count="PAGE_COUNT"
        :swipe-disabled="page === PAGE_COUNT - 1"
        @skip="finish"
      >
        <template #slide="{ index, active }">
          <WelcomeScreen v-if="index === 0" />
          <TopicsScreen v-else-if="index === 1" :topics="topicOptions" v-model="selectedTopicIds" />
          <DailyWisdomScreen
            v-else-if="index === 2"
            :enabled="wisdomEnabled"
            :time="wisdomTime"
            :topic-ids="selectedTopicIds"
            :active="active"
            @update:enabled="onWisdomEnabledChange"
            @update:time="wisdomTime = $event"
          />
          <ValueMomentScreen
            v-else-if="index === 3"
            :topic-ids="selectedTopicIds"
            :active="active"
          />
          <PaywallScreen
            v-else
            :legal-documents="subscription.legalDocuments"
            :restoring="subscription.restoring"
            @restore="subscription.onRestore"
          />
        </template>

        <!-- Bottom actions: the paywall's plans + CTA live here (footer); the
             disclaimer is hidden and Restore/legal move up into the page. Other
             screens show the primary Continue button. -->
        <template #actions>
          <SubscriptionFooter
            v-if="page === PAGE_COUNT - 1"
            class="ob-paywall-footer"
            :packages="subscription.packages"
            :is-subscribed="subscription.isSubscribed"
            :ready="subscription.ready"
            :purchasing="subscription.purchasing"
            :restoring="subscription.restoring"
            :legal-documents="subscription.legalDocuments"
            :show-cant-pay="subscription.showCantPay"
            :hide-disclaimer="true"
            :hide-secondary="true"
            @subscribe="subscription.onSubscribe"
            @restore="subscription.onRestore"
            @manage="subscription.onManage"
            @cant-pay="subscription.onCantPay"
          />
          <IonButton v-else expand="block" :strong="true" class="ob-primary" @click="onPrimary">
            {{ primaryLabel }}
          </IonButton>
        </template>
      </OnboardingCarousel>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { IonButton, IonContent, IonPage, useIonRouter } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { SubscriptionFooter } from "@ui/features/subscription/index.js"
import { useSubscriptionBinding } from "@shruti/views/Settings/composables/useSubscriptionBinding.js"
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
import ValueMomentScreen from "./screens/ValueMomentScreen.vue"
import PaywallScreen from "./screens/PaywallScreen.vue"
import type { LanguageCode } from "@lib/domain/core.js"

const PAGE_COUNT = 5

const app = useShruti()
const ionRouter = useIonRouter()
const { t } = useI18n()
const appLanguage = useAppLanguage()
const filtersStore = useSearchFiltersStore()
const onboarding = useOnboardingStore()
const subscription = useSubscriptionBinding()

// A successful purchase on the paywall completes onboarding.
watch(
  () => subscription.isSubscribed,
  (now, was) => {
    if (now && !was) void finish()
  }
)

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
</script>

<style scoped>
/* The Continue button and the paywall CTA share radius (12px) + strong text so
   they look identical across screens. */
.ob-primary {
  width: 100%;
  max-width: 440px;
  margin: 0;
  --box-shadow: none;
  --border-radius: 12px;
}
.ob-paywall-footer {
  width: 100%;
  max-width: 440px;
}
</style>
