<template>
  <img :src="src" :alt="alt" :class="{ image: true, visible }" @load="onLoad" />
</template>

<script setup lang="ts">
/**
 * An `<img>` that fades in once the resource has loaded, avoiding the abrupt
 * pop-in of a freshly decoded image. Emits `load` when ready. Fully generic.
 */
import { ref } from "vue"

defineProps<{
  src: string
  alt?: string
}>()

const emit = defineEmits<{
  load: []
}>()

const visible = ref(false)

function onLoad() {
  visible.value = true
  emit("load")
}
</script>

<style scoped>
.image {
  opacity: 0;
  transition: opacity 0.15s ease-in-out;
}

.image.visible {
  opacity: 1;
}
</style>
