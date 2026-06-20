<template>
  <div class="ob-wisdom">
    <div class="ob-wisdom__head">
      <h1 class="ob-wisdom__title">{{ $t("onboarding.wisdom.title") }}</h1>
      <p class="ob-wisdom__subtitle">{{ $t("onboarding.wisdom.subtitle") }}</p>
    </div>

    <IonList inset>
      <IonItem>
        <IonToggle
          :checked="enabled"
          data-testid="onboarding-wisdom-toggle"
          @ionChange="emit('update:enabled', $event.detail.checked)"
        >
          {{ $t("onboarding.wisdom.toggle") }}
        </IonToggle>
      </IonItem>
    </IonList>

    <div v-if="enabled" class="ob-wisdom__time">
      <p class="ob-wisdom__time-label">{{ $t("onboarding.wisdom.time") }}</p>
      <div class="ob-wisdom__presets">
        <button
          v-for="p in presets"
          :key="p.key"
          type="button"
          class="ob-chip"
          :class="{ 'ob-chip--on': time[0] === p.hour }"
          @click="emit('update:time', [p.hour, 0])"
        >
          {{ $t(p.labelKey) }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { IonItem, IonList, IonToggle } from "@ionic/vue"

defineProps<{
  enabled: boolean
  time: [number, number]
}>()

const emit = defineEmits<{
  (e: "update:enabled", value: boolean): void
  (e: "update:time", value: [number, number]): void
}>()

const presets = [
  { key: "morning", hour: 9, labelKey: "onboarding.wisdom.morning" as const },
  { key: "afternoon", hour: 14, labelKey: "onboarding.wisdom.afternoon" as const },
  { key: "evening", hour: 19, labelKey: "onboarding.wisdom.evening" as const },
] as const
</script>

<style scoped>
.ob-wisdom {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 8px 12px 24px;
  box-sizing: border-box;
}
.ob-wisdom__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
  padding: 0 8px;
}
.ob-wisdom__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.ob-wisdom__subtitle {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-wisdom__time {
  text-align: center;
}
.ob-wisdom__time-label {
  margin: 0 0 10px;
  font-size: 0.85rem;
  color: var(--ion-color-medium);
}
.ob-wisdom__presets {
  display: flex;
  justify-content: center;
  gap: 10px;
}
.ob-chip {
  padding: 10px 16px;
  border-radius: 999px;
  border: 1.5px solid var(--ion-color-step-200, #e0e0e0);
  background: transparent;
  color: var(--ion-text-color);
  font-size: 0.92rem;
  cursor: pointer;
}
.ob-chip--on {
  border-color: var(--ion-color-primary);
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}
</style>
