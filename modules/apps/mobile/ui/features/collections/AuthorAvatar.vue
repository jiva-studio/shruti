<template>
  <span class="author-avatar">
    <img
      v-if="src"
      :src="src"
      :alt="alt ?? ''"
      class="img"
      :class="{ 'is-loaded': loaded }"
      @load="loaded = true"
    />
  </span>
</template>

<script setup lang="ts">
import { ref, toRef } from "vue"
import { useCachedImageUrl } from "@ui/primitives/index.js"

/**
 * A single circular author avatar, served through the local image cache. Sized
 * by the parent via the `--author-avatar-size` CSS var; falls back to a cream
 * disc while the photo loads or when there's no image.
 */
const props = defineProps<{
  /** Remote avatar URL (already region-resolved). */
  url?: string
  alt?: string
}>()

const { src } = useCachedImageUrl(toRef(props, "url"))
const loaded = ref(false)
</script>

<style scoped>
.author-avatar {
  display: block;
  width: var(--author-avatar-size, 28px);
  height: var(--author-avatar-size, 28px);
  border-radius: 50%;
  overflow: hidden;
  background: var(--ion-color-light);
  /* Ring so overlapping avatars stay visually separated over any cover. */
  box-shadow: 0 0 0 2px var(--lectorium-scrim-cream);
}

.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 200ms ease;
}

.img.is-loaded {
  opacity: 1;
}
</style>
