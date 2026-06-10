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

    <IonContent>
      <div class="layout">
        <div class="carousel-host">
          <FeatureCarousel
            :page-count="slides.length"
            :initial-page="initialIndex"
            @update:index="setIndex"
          >
            <template #default="{ index: i }">
              <FeatureSlide
                :icon="slides[i].icon"
                :title="slides[i].title"
                :description="slides[i].description"
                :soon="slides[i].soon"
              />
            </template>
          </FeatureCarousel>
        </div>
        <SubscriptionFooter
          :packages="subscription.packages"
          :is-subscribed="subscription.isSubscribed"
          :purchasing="subscription.purchasing"
          :restoring="subscription.restoring"
          :legal-documents="subscription.legalDocuments"
          :show-cant-pay="subscription.showCantPay"
          @subscribe="subscription.onSubscribe"
          @restore="subscription.onRestore"
          @manage="subscription.onManage"
          @cant-pay="subscription.onCantPay"
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
import {
  FeatureCarousel,
  FeatureSlide,
  SubscriptionFooter,
} from "@ui/features/subscription/index.js"
import { useSubscriptionViewController } from "./SubscriptionView.controller.js"

const { subscription, slides, initialIndex, setIndex } = useSubscriptionViewController()
const defaultBackHref = "/tabs/settings"
</script>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  /* Fill the viewport on tall screens (carousel grows, footer sits at the
     bottom) but allow the column to overflow and IonContent to scroll on
     short ones, instead of squeezing everything into a single screen. */
  min-height: 100%;
}

.carousel-host {
  flex: 1 1 auto;
  /* Floor the hero height so the illustration always has room and the slide
     can centre comfortably. */
  min-height: clamp(340px, 52vh, 480px);
  position: relative;
}

/* Fill the host with the carousel via absolute positioning. This gives the
   carousel a definite pixel height (so the slide's own vertical centring works
   reliably, unlike a percentage-height chain), the slide art + text land in the
   middle of the hero, and the dots — pinned to the carousel's bottom — drop to
   just above the footer button instead of floating mid-screen. */
.layout .carousel-host > * {
  position: absolute;
  inset: 0;
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
