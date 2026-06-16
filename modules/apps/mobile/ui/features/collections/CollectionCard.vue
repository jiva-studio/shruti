<template>
  <button
    type="button"
    class="collection-card"
    :class="{ 'is-loaded': loaded }"
    @click="emit('click')"
  >
    <CachedImage :url="coverUrl" :alt="name" @loaded="loaded = true" />
    <span class="scrim" aria-hidden="true" />
    <span class="name"><span v-if="hashtag" class="hash">#</span>{{ name }}</span>
  </button>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { CachedImage } from "@ui/primitives/index.js"

/**
 * One collection card for the Search carousel: cover image with the name
 * overlaid at the bottom over a readability scrim. (The author is shown inside
 * the detail sheet, not on the card.)
 *
 * The tile keeps a light placeholder background at all times; the cover (a
 * `CachedImage` fill layer) fades in on top of it, so there is no flash between
 * states. The name is always shown — dark over the bare placeholder, animating
 * to cream as the scrim fades in with the image once `CachedImage` reports
 * `loaded`. The scrim itself only appears over an actual cover.
 */
defineProps<{
  name: string
  /** Remote cover image URL, or undefined to keep the placeholder tile. */
  coverUrl?: string
  /** Prefix the name with a "#" — used when the card is a topic, not a collection. */
  hashtag?: boolean
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
  border-radius: 4px;
  overflow: hidden;
  background: var(--ion-color-light);
  box-shadow: 0 1px 4px rgba(var(--ion-color-dark-rgb), 0.12);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  scroll-snap-align: start;
  transition: transform 120ms ease;
}

.collection-card:active {
  transform: scale(0.97);
}

/* Readability scrim behind the name — fades in with the image (matching
   CachedImage's 200ms fade), absent over the bare placeholder. */
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
  /* Always visible. Over the bare placeholder it's the dark theme text colour
     (legible on the light tile); when the cover + scrim fade in, it animates to
     warm cream (fixed tone, doesn't invert) so it stays legible over the image. */
  color: var(--ion-text-color);
  transition: color 200ms ease;
  /* Two-line clamp so long names don't overrun the tile. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.collection-card.is-loaded .scrim {
  opacity: 1;
}

.collection-card.is-loaded .name {
  color: var(--shruti-scrim-cream);
}

.hash {
  opacity: 0.6;
  margin-inline-end: 1px;
}
</style>
