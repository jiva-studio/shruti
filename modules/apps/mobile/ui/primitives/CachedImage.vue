<template>
  <img
    v-if="src"
    :src="src"
    :alt="alt ?? ''"
    class="cached-image"
    :class="{ 'is-loaded': loaded }"
    @load="loaded = true"
  />
</template>

<script setup lang="ts">
import { ref, toRef } from "vue"
import { useCachedImageUrl } from "@lectorium/composables/useCachedImageUrl.js"

/**
 * An <img> served through the local image cache, as an absolute fill layer
 * that fades in once decoded. The parent supplies a sized, position:relative
 * container (and its own placeholder background). Nothing renders until the
 * cached URL resolves, so the container's placeholder shows meanwhile.
 */
const props = defineProps<{
  url?: string
  alt?: string
}>()

const { src } = useCachedImageUrl(toRef(props, "url"))
const loaded = ref(false)
</script>

<style scoped>
.cached-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 200ms ease;
}

.cached-image.is-loaded {
  opacity: 1;
}
</style>
