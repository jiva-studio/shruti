<template>
  <div v-if="names.length" class="topic-chips">
    <span v-for="(name, i) in visible" :key="i" class="topic-chip">
      <IconHash :size="11" class="chip-hash" />
      {{ name }}
    </span>
    <span v-if="overflow" class="topic-chip more">+{{ overflow }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IconHash } from "@tabler/icons-vue"

/**
 * A wrapping row of "#topic" chips, capped at `max` with a "+N" overflow chip.
 */
const props = withDefaults(defineProps<{ names: readonly string[]; max?: number }>(), {
  max: 4,
})

const visible = computed(() => props.names.slice(0, props.max))
const overflow = computed(() => Math.max(0, props.names.length - props.max))
</script>

<style scoped>
.topic-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 6px;
  margin: 0 0 16px;
}

.topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--ion-color-medium-shade, #666);
  background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
}

.chip-hash {
  flex: none;
  opacity: 0.55;
}
</style>
