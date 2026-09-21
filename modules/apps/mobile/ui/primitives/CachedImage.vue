<script setup lang="ts">
import { ref, toRef, watch } from "vue"
import { useCachedImageUrl } from "./useCachedImageUrl.js"

/**
 * An <img> served through the local image cache, as an absolute fill layer
 * shown once decoded. The parent supplies a sized, position:relative container
 * (and its own placeholder background). Nothing renders until the cached URL
 * resolves, so the container's placeholder shows meanwhile. Emits `loaded` once
 * decoded so a parent can reveal cover-dependent chrome (e.g. a readability
 * scrim) only after the image is actually visible.
 */
const props = defineProps<{
  url?: string
  alt?: string
}>()

const emit = defineEmits<{ (e: "loaded"): void }>()

const { src, retry } = useCachedImageUrl(toRef(props, "url"))
const loaded = ref(false)

// Re-hide (and re-arm the parent's scrim) until the new source decodes.
watch(
  () => props.url,
  () => (loaded.value = false)
)

function onLoad() {
  loaded.value = true
  emit("loaded")
}

// The rendered src failed to decode (e.g. the cached resolve fell back to the
// raw remote URL and that link is flaky too). Ask the composable to re-attempt
// the cached resolve; it's bounded, so a permanently-dead cover just stops
// retrying and stays on the parent's placeholder rather than looping.
function onError() {
  retry()
}
</script>

<template>
  <img
    v-if="src"
    :src="src"
    :alt="alt ?? ''"
    class="cached-image"
    :class="{ 'is-loaded': loaded }"
    @load="onLoad"
    @error="onError"
  />
</template>

<style scoped>
.cached-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* Hidden until decoded, then shown instantly (no fade) — covers are prewarmed
     into the cache, so they decode immediately and a fade would only add lag. */
  opacity: 0;
}

.cached-image.is-loaded {
  opacity: 1;
}
</style>
