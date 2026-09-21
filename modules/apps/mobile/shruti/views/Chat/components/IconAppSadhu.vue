<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(defineProps<{ size?: number }>(), { size: 28 })

const wrapStyle = computed(() => ({
  width: `${props.size + 4}px`,
  height: `${props.size + 4}px`,
}))
</script>

<template>
  <span class="app-icon-wrap" :style="wrapStyle">
    <img
      src="/agent-icon.png"
      alt="Chat"
      :width="size"
      :height="size"
      class="app-icon-img"
      draggable="false"
    />
  </span>
</template>

<style scoped>
.app-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  /* No `overflow: hidden` here: the disc background and the <img> are both
   * already circular via border-radius, so clipping buys nothing visually
   * but lets the tab button crop the bottom of the icon on iOS (#769). */
  /* Subtle tinted disc behind the icon so the tab bar reads it as a
   * "branded" entry rather than a stray PNG floating among Tabler
   * glyphs. Opacity tuned to feel translucent without washing the icon. */
  background: rgba(var(--ion-color-primary-rgb), 0.1);
  padding: 2px;
  /* Translucent app icon as the user requested — keeps the disc legible
   * over the gradient tab bar. */
  opacity: 0.95;
}

.app-icon-img {
  border-radius: 50%;
  display: block;
}
</style>
