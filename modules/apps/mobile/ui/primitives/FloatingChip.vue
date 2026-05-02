<template>
  <div class="floating-chip" :class="{ hidden: !visible }">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** Absolute `top` offset in CSS units (e.g. "120px"). */
  positionTop: string
  /** When false, fades the chip out without unmounting. */
  visible: boolean
}>()
</script>

<style scoped>
.floating-chip {
  position: absolute;
  top: v-bind(positionTop);
  left: 10px;
  font-size: 0.75rem;
  padding: 0.25rem;
  border-radius: 5px;
  background-color: var(--ion-color-warning);
  transition: all 100ms ease-in-out;
  transform: translateY(-100%);
}

.hidden {
  opacity: 0;
}
</style>
