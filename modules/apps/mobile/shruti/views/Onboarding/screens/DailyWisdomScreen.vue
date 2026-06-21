<template>
  <div class="ob-wisdom">
    <div class="ob-wisdom__head">
      <h1 class="ob-wisdom__title">{{ $t("onboarding.wisdom.title") }}</h1>
      <p class="ob-wisdom__subtitle">{{ $t("onboarding.wisdom.subtitle") }}</p>
    </div>

    <div class="ob-wisdom__presets" role="radiogroup">
      <button
        type="button"
        class="ob-chip"
        :class="{ 'ob-chip--on': !enabled }"
        role="radio"
        :aria-checked="!enabled"
        data-testid="onboarding-wisdom-off"
        @click="emit('update:enabled', false)"
      >
        {{ $t("onboarding.wisdom.off") }}
      </button>
      <button
        v-for="p in presets"
        :key="p.key"
        type="button"
        class="ob-chip"
        :class="{ 'ob-chip--on': enabled && time[0] === p.hour }"
        role="radio"
        :aria-checked="enabled && time[0] === p.hour"
        @click="selectTime(p.hour)"
      >
        {{ $t(p.labelKey) }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  enabled: boolean
  time: [number, number]
}>()

const emit = defineEmits<{
  (e: "update:enabled", value: boolean): void
  (e: "update:time", value: [number, number]): void
}>()

function selectTime(hour: number): void {
  emit("update:time", [hour, 0])
  if (!props.enabled) emit("update:enabled", true)
}

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
  gap: 28px;
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
.ob-wisdom__presets {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
.ob-chip {
  padding: 10px 18px;
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
