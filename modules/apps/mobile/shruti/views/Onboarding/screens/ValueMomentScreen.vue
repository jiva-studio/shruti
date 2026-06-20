<template>
  <div class="ob-value">
    <div class="ob-value__head">
      <h1 class="ob-value__title">{{ $t("onboarding.value.title") }}</h1>
      <p class="ob-value__subtitle">{{ $t("onboarding.value.subtitle") }}</p>
    </div>
    <IonList v-if="lectures.length > 0" inset data-testid="onboarding-lectures">
      <IonItem v-for="l in lectures" :key="l.id" lines="full">
        <IonIcon :icon="playCircleOutline" slot="start" color="primary" />
        <IonLabel class="ob-value__lecture">{{ l.title }}</IonLabel>
      </IonItem>
    </IonList>
    <p v-else class="ob-value__empty">{{ $t("onboarding.value.empty") }}</p>
  </div>
</template>

<script setup lang="ts">
import { IonIcon, IonItem, IonLabel, IonList } from "@ionic/vue"
import { playCircleOutline } from "ionicons/icons"

export interface OnboardingLecture {
  id: string
  title: string
}

defineProps<{
  lectures: readonly OnboardingLecture[]
}>()
</script>

<style scoped>
.ob-value {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 12px 24px;
  box-sizing: border-box;
}
.ob-value__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
  padding: 0 8px;
}
.ob-value__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.ob-value__subtitle {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-value__lecture {
  font-size: 0.92rem;
  white-space: normal;
}
.ob-value__empty {
  text-align: center;
  color: var(--ion-color-medium);
}
</style>
