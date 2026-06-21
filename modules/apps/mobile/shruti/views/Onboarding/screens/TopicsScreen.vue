<template>
  <div class="ob-topics">
    <div class="ob-topics__head">
      <h1 class="ob-topics__title">{{ $t("onboarding.topics.title") }}</h1>
      <p class="ob-topics__subtitle">{{ $t("onboarding.topics.subtitle") }}</p>
    </div>
    <div class="ob-topics__chips" data-testid="onboarding-topics">
      <button
        v-for="t in topics"
        :key="t.id"
        type="button"
        class="ob-chip"
        :class="{ 'ob-chip--on': selected.has(t.id) }"
        :aria-pressed="selected.has(t.id)"
        @click="toggle(t.id)"
      >
        {{ t.label }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { OnboardingTopicOption } from "../loadOnboardingTopics.js"

const props = defineProps<{
  topics: readonly OnboardingTopicOption[]
  modelValue: readonly string[]
}>()

const emit = defineEmits<{ (e: "update:modelValue", ids: string[]): void }>()

const selected = computed(() => new Set(props.modelValue))

function toggle(id: string): void {
  const next = new Set(props.modelValue)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  emit("update:modelValue", [...next])
}
</script>

<style scoped>
.ob-topics {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 8px 20px 24px;
  box-sizing: border-box;
}
.ob-topics__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
}
.ob-topics__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.ob-topics__subtitle {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-topics__chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  max-width: 520px;
  margin: 0 auto;
}
.ob-chip {
  padding: 10px 16px;
  border-radius: 999px;
  border: 1.5px solid var(--ion-color-step-200, #e0e0e0);
  background: transparent;
  color: var(--ion-text-color);
  font-size: 0.92rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}
.ob-chip--on {
  border-color: var(--ion-color-primary);
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}
</style>
