<template>
  <button
    type="button"
    class="collection-card"
    :class="{ 'is-placeholder': !coverUrl }"
    @click="emit('click')"
  >
    <CachedImage :url="coverUrl" :alt="name" />
    <span class="name">{{ name }}</span>
  </button>
</template>

<script setup lang="ts">
import { CachedImage } from "@ui/primitives/index.js"

/**
 * One collection card for the Search carousel: cover image with the name
 * overlaid at the bottom over a readability scrim. Falls back to a cream
 * gradient tile when no cover is published yet, so the card never shows a
 * broken image. (The author is shown inside the detail sheet, not on the card.)
 *
 * The cover (a `CachedImage` fill layer) is out of flow over a fixed-size
 * tile, so the name stays pinned to the bottom and never jumps while it loads.
 */
defineProps<{
  name: string
  /** Remote cover image URL, or undefined to show the placeholder tile. */
  coverUrl?: string
}>()

const emit = defineEmits<{ (e: "click"): void }>()
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

/* No cover yet → warm saffron→coffee tile in the cream palette. */
.collection-card.is-placeholder {
  background: linear-gradient(
    135deg,
    rgba(var(--ion-color-primary-rgb), 0.55),
    rgba(var(--ion-color-tertiary-rgb), 0.7)
  );
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
  /* Warm cream text on a warm espresso scrim — matches the palette instead of
     stark white-on-black. Fixed tones (not theme vars, which invert) so the
     overlay stays legible over any cover in both themes. */
  color: #f4ebdd;
  background: linear-gradient(to top, rgba(61, 43, 31, 0.72), rgba(61, 43, 31, 0));
  /* Two-line clamp so long names don't overrun the tile. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
