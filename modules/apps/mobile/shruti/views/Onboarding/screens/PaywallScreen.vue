<template>
  <div class="ob-paywall">
    <div class="ob-paywall__head">
      <h1 class="ob-paywall__title">{{ $t("onboarding.paywall.title") }}</h1>
      <p class="ob-paywall__subtitle">{{ $t("onboarding.paywall.subtitle") }}</p>
    </div>
    <!-- The hybrid paywall (screenshot hero + reused SubscriptionFooter) lands
         in the paywall task; this is the value framing shown above it. -->
  </div>
</template>

<script setup lang="ts"></script>

<style scoped>
.ob-paywall {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
  height: 100%;
  padding: 16px 24px;
  box-sizing: border-box;
}
.ob-paywall__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
}
.ob-paywall__title {
  margin: 0 0 12px;
  font-size: 1.5rem;
  font-weight: 800;
  color: var(--ion-text-color);
}
.ob-paywall__subtitle {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.5;
  color: var(--ion-color-medium);
}
</style>
