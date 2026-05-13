<template>
  <button
    type="button"
    class="search-filters-button"
    :class="{ 'is-active': active }"
    :aria-label="ariaLabel"
    @click="emit('click')"
  >
    <IconFilterFilled class="icon" :size="20" />
  </button>
</template>

<script setup lang="ts">
import { IconFilterFilled } from "@tabler/icons-vue"

withDefaults(
  defineProps<{
    active?: boolean
    ariaLabel?: string
  }>(),
  { active: false, ariaLabel: "Filters" }
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
  background: transparent;
  color: var(--ion-color-medium, currentColor);
  -webkit-tap-highlight-color: transparent;
  transition: color 120ms ease;
}

.search-filters-button.is-active {
  color: var(--ion-color-primary);
}

.icon {
  width: 20px;
  height: 20px;
}
</style>
