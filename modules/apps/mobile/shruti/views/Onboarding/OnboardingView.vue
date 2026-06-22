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
            :active="active"
            @update:enabled="onWisdomEnabledChange"
            @update:time="wisdomTime = $event"
          />
          <ValueMomentScreen
            v-else-if="index === 3"
            :topic-ids="selectedTopicIds"
            :seed="page > TOPICS_PAGE"
          />
          <PaywallScreen
            v-else
            :legal-documents="subscription.legalDocuments"
            :restoring="subscription.restoring"
            @restore="onRestore"
          />
        </template>

        <!-- Bottom actions: the paywall's plans + CTA live here (footer); the
             disclaimer is hidden and Restore/legal move up into the page. Other
             screens show the primary Continue button. -->
        <template #actions>
          <!-- The onboarding paywall composes just the purchase block; its
               Restore/legal links live in PaywallScreen and there's no
               disclaimer here. -->
          <SubscriptionPlans
            v-if="page === PAGE_COUNT - 1"
            class="ob-paywall-footer"
            :packages="subscription.packages"
            :ready="subscription.ready"
            :purchasing="subscription.purchasing"
            @subscribe="onSubscribe"
          />
          <IonButton
            v-else
            expand="block"
            :strong="true"
            class="ob-primary"
            data-testid="onboarding-primary"
            @click="onPrimary"
          >
            {{ primaryLabel }}
          </IonButton>
        </template>
      </OnboardingCarousel>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { IonButton, IonContent, IonPage } from "@ionic/vue"
import { SubscriptionPlans } from "@ui/features/subscription/index.js"
import OnboardingCarousel from "@ui/features/onboarding/OnboardingCarousel.vue"
import WelcomeScreen from "./screens/WelcomeScreen.vue"
import TopicsScreen from "./screens/TopicsScreen.vue"
import DailyWisdomScreen from "./screens/DailyWisdomScreen.vue"
import ValueMomentScreen from "./screens/ValueMomentScreen.vue"
import PaywallScreen from "./screens/PaywallScreen.vue"
import {
  useOnboardingViewController,
  PAGE_COUNT,
  TOPICS_PAGE,
} from "./OnboardingView.controller.js"

const {
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
} = useOnboardingViewController()
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
