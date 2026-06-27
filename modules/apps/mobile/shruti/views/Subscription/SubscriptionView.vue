<template>
  <IonPage class="subscription-page">
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton :default-href="defaultBackHref" />
        </IonButtons>
        <IonTitle>{{ $t("settings.subscription.title") }}</IonTitle>
      </IonToolbar>
    </IonHeader>

    <IonContent :fullscreen="true">
      <div class="layout">
        <div class="head">
          <h1 class="head__title">{{ $t("onboarding.paywall.title") }}</h1>
          <p class="head__subtitle">{{ $t("onboarding.paywall.subtitle") }}</p>
        </div>

        <SubscriptionShots class="shots" :shots="shots" :initial-key="initialKey" />

        <SubscriptionFooter
          class="settings-footer"
          :packages="subscription.packages"
          :is-subscribed="subscription.isSubscribed"
          :ready="subscription.ready"
          :purchasing="subscription.purchasing"
          :restoring="subscription.restoring"
          :legal-documents="subscription.legalDocuments"
          @subscribe="subscription.onSubscribe"
          @restore="subscription.onRestore"
          @manage="subscription.onManage"
        />
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { SubscriptionFooter, SubscriptionShots } from "@ui/features/subscription/index.js"
import { useSubscriptionViewController } from "./SubscriptionView.controller.js"

const { subscription, shots, initialKey } = useSubscriptionViewController()
const defaultBackHref = "/tabs/settings"
</script>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  /* Fill the viewport on tall screens (shots + head grow, footer sits at the
     bottom) but allow the column to overflow and IonContent to scroll on
     short ones, instead of squeezing everything into a single screen. */
  min-height: 100%;
  padding: 12px 16px calc(env(safe-area-inset-bottom, 0px) + 24px);
  box-sizing: border-box;
}

.head {
  text-align: center;
  max-width: 440px;
  /* auto bottom on .shots centres the head + strip group in the space above
     the footer. */
  margin: 0 auto;
}
.head__title {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 800;
  color: var(--ion-text-color);
}
.head__subtitle {
  margin: 8px 0 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}

.shots {
  /* Top/bottom only — leave the inline margin to SubscriptionShots' own
     negative margin-inline (full-bleed). A shorthand here would reset it to 0
     and re-inset the carousel by the layout's 16px padding. */
  margin-top: 16px;
  margin-bottom: auto;
}

.settings-footer {
  margin-top: 16px;
}
</style>

<style>
/* IonHeader paints Material's elevation shadow + a gradient under the
   toolbar; drop both so the page surface stays flat like Settings does
   via AppPage. Match the modal-override pattern used in
   SmartLibraryDialog.vue / the old SubscriptionDialog.vue. */
.subscription-page ion-header,
.subscription-page ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.subscription-page ion-header::after {
  display: none;
}
</style>
