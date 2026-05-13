<template>
  <button
    type="button"
    class="search-filters-button"
    :class="{ 'is-active': count > 0 }"
    :aria-label="ariaLabel"
    @click="emit('click')"
  >
    <IonIcon :icon="funnelOutline" class="icon" />
    <SectionBadge v-if="count > 0" accent class="count">{{ count }}</SectionBadge>
  </button>
</template>

<script setup lang="ts">
import { IonIcon } from "@ionic/vue"
import { funnelOutline } from "ionicons/icons"
import { SectionBadge } from "@ui/primitives/index.js"

withDefaults(
  defineProps<{
    count?: number
    ariaLabel?: string
  }>(),
  { count: 0, ariaLabel: "Filters" }
)

const emit = defineEmits<{ click: [] }>()
</script>

<style scoped>
.search-filters-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--ion-color-medium, currentColor);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.search-filters-button:active {
  background: var(--ion-color-medium, rgba(0, 0, 0, 0.12));
}

.search-filters-button.is-active {
  color: var(--ion-color-primary);
}

.icon {
  width: 20px;
  height: 20px;
}

.count {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  padding: 0 6px;
  font-size: 0.7rem;
  line-height: 1.4;
}
</style>
