<template>
  <button
    type="button"
    class="collection-card"
    :class="{ 'is-placeholder': !loaded, 'is-loaded': loaded }"
    @click="emit('click')"
  >
    <CachedImage :url="coverUrl" :alt="name" @loaded="loaded = true" />
    <span class="scrim" aria-hidden="true" />
    <span class="name">{{ name }}</span>
  </button>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { CachedImage } from "@ui/primitives/index.js"

/**
 * One collection card for the Search carousel: cover image with the name
 * overlaid at the bottom over a readability scrim. Falls back to a cream
 * gradient tile when no cover is published yet, so the card never shows a
 * broken image. (The author is shown inside the detail sheet, not on the card.)
 *
 * The cover (a `CachedImage` fill layer) is out of flow over a fixed-size
 * tile, so the name stays pinned to the bottom and never jumps while it loads.
 *
 * Until the cover has decoded we keep the solid placeholder tile and hide the
 * bottom scrim — the scrim only makes sense over an actual image, and on the
 * plain tile it would read as a stray dark band. Both reveal together once the
 * `CachedImage` reports `loaded`.
 */
defineProps<{
  name: string
  /** Remote cover image URL, or undefined to show the placeholder tile. */
  coverUrl?: string
}>()

const emit = defineEmits<{ (e: "click"): void }>()

const loaded = ref(false)
</script>

<style scoped>
.collection-card {
  position: relative;
  width: 140px;
  height: 140px;
  flex: 0 0 auto;
  appearance: none;
  border: none;
  margin: 0;
  padding: 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--ion-color-light);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  scroll-snap-align: start;
  transition: transform 120ms ease;
}

.collection-card:active {
  transform: scale(0.97);
}

/* Cover not decoded yet (or none published) → flat warm coffee tile, so the
   card never flashes a broken/empty image. Fixed tone (not a theme var, which
   inverts) so the overlaid cream name stays legible in both themes, and shared
   verbatim with CollectionListItem's thumb so the two cards match. */
.collection-card.is-placeholder {
  background: #6f4e37;
}

/* Readability scrim behind the name — only over an actual cover. Fades in with
   the image (matching CachedImage's 200ms fade), hidden over the placeholder. */
.scrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 60%;
  /* Warm espresso, not stark black. Fixed tones (not theme vars, which invert)
     so the overlay stays legible over any cover in both themes. */
  background: linear-gradient(to top, rgba(61, 43, 31, 0.72), rgba(61, 43, 31, 0));
  opacity: 0;
  transition: opacity 200ms ease;
  pointer-events: none;
}

.collection-card.is-loaded .scrim {
  opacity: 1;
}

.name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 18px 10px 8px;
  text-align: left;
  font-size: 13px;
  line-height: 1.25;
  font-weight: 600;
  /* Warm cream text — legible over both the scrim and the placeholder tile. */
  color: #f4ebdd;
  /* Two-line clamp so long names don't overrun the tile. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
