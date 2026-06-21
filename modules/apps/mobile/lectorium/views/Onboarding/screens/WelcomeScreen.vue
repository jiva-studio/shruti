<template>
  <div class="ob-welcome">
    <div class="ob-welcome__hero">
      <img class="ob-welcome__logo" src="/welcome.png" :alt="$t('onboarding.welcome.appName')" />
    </div>
    <div class="ob-welcome__body">
      <h1 class="ob-welcome__title">{{ $t("onboarding.welcome.appName") }}</h1>
      <p class="ob-welcome__punch">{{ $t("onboarding.welcome.punch") }}</p>
    </div>
  </div>
</template>

<script setup lang="ts"></script>

<style scoped>
.ob-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  height: 100%;
  padding: 16px 24px;
  box-sizing: border-box;
}
.ob-welcome__hero {
  display: flex;
  align-items: center;
  justify-content: center;
}
.ob-welcome__logo {
  width: clamp(200px, 64vw, 320px);
  aspect-ratio: 1 / 1;
  height: auto;
  object-fit: contain;
  filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.14));
}
.ob-welcome__body {
  max-width: 440px;
  text-align: center;
}
.ob-welcome__title {
  margin: 0 0 12px;
  font-size: 1.7rem;
  font-weight: 800;
  color: var(--ion-text-color);
}
.ob-welcome__punch {
  margin: 0;
  font-size: 1rem;
  line-height: 1.5;
  color: var(--ion-color-medium);
}
</style>
