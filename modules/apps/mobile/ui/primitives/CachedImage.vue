<template>
  <img
    v-if="src"
    :src="src"
    :alt="alt ?? ''"
    class="cached-image"
    :class="{ 'is-loaded': loaded }"
    @load="onLoad"
  />
</template>

<script setup lang="ts">
import { ref, toRef, watch } from "vue"
import { useCachedImageUrl } from "./useCachedImageUrl.js"

/**
 * An <img> served through the local image cache, as an absolute fill layer
 * that fades in once decoded. The parent supplies a sized, position:relative
 * container (and its own placeholder background). Nothing renders until the
 * cached URL resolves, so the container's placeholder shows meanwhile. Emits
 * `loaded` once decoded so a parent can reveal cover-dependent chrome (e.g. a
 * readability scrim) only after the image is actually visible.
 */
const props = defineProps<{
  url?: string
  alt?: string
}>()

const emit = defineEmits<{ (e: "loaded"): void }>()

const { src } = useCachedImageUrl(toRef(props, "url"))
const loaded = ref(false)

// Re-arm the fade (and the parent's scrim) when the source changes.
watch(
  () => props.url,
  () => (loaded.value = false)
)

function onLoad() {
  loaded.value = true
  emit("loaded")
}
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
