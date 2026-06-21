<template>
  <div class="ob-topics">
    <OnboardingHeading
      :title="$t('onboarding.topics.title')"
      :subtitle="$t('onboarding.topics.subtitle')"
    />
    <div class="ob-topics__chips" data-testid="onboarding-topics">
      <ToggleChip
        v-for="t in topics"
        :key="t.id"
        :selected="selected.has(t.id)"
        @toggle="toggle(t.id)"
      >
        {{ t.label }}
      </ToggleChip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { ToggleChip } from "@ui/primitives/index.js"
import OnboardingHeading from "@ui/features/onboarding/OnboardingHeading.vue"
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
.ob-topics__chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  max-width: 520px;
  margin: 0 auto;
}
</style>
