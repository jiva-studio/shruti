<template>
  <button
    type="button"
    class="collection-card"
    :class="{ 'is-placeholder': !coverUrl }"
    @click="emit('click')"
  >
    <img
      v-if="src"
      :src="src"
      :alt="name"
      class="cover"
      :class="{ 'is-loaded': loaded }"
      @load="loaded = true"
    />
    <span v-if="authorImageUrls && authorImageUrls.length" class="author-pile">
      <AuthorAvatar v-for="(url, i) in shownAuthors" :key="i" :url="url" :alt="name" />
    </span>
    <span class="name">{{ name }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from "vue"
import { useCachedImageUrl } from "@lectorium/composables/useCachedImageUrl.js"
import AuthorAvatar from "./AuthorAvatar.vue"

/**
 * One collection card for the Search carousel: cover image with the name
 * overlaid at the bottom over a readability scrim. Falls back to a cream
 * gradient tile when no cover is published yet, so the card never shows a
 * broken image.
 *
 * The cover is served through `useCachedImageUrl` so it's fetched from S3 once
 * and reused from the local cache afterwards. The image is an
 * absolutely-positioned layer (out of flow) over a fixed-size tile, so the
 * name stays pinned to the bottom and never jumps while the cover loads.
 */
const props = defineProps<{
  name: string
  /** Remote cover image URL, or undefined to show the placeholder tile. */
  coverUrl?: string
  /** Author avatar URLs, rendered as overlapping circles, top-right. */
  authorImageUrls?: readonly string[]
}>()

const emit = defineEmits<{ (e: "click"): void }>()

const { src } = useCachedImageUrl(toRef(props, "coverUrl"))
const loaded = ref(false)

// Cap the pile so a many-author collection doesn't overrun the corner.
const shownAuthors = computed(() => (props.authorImageUrls ?? []).slice(0, 3))
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

/* Cover is an absolute fill layer so it's fully out of flow: the tile keeps
   its fixed square and the name stays anchored to the bottom regardless of
   whether the image has loaded yet. Fades in once decoded to avoid a flash. */
.collection-card .cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 200ms ease;
}

.collection-card .cover.is-loaded {
  opacity: 1;
}

/* Author avatar pile — overlapping circles in the top-right corner, above the
   cover. Negative gap makes each avatar tuck under the previous one. */
.author-pile {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  flex-direction: row-reverse;
  --author-avatar-size: 26px;
}

.author-pile :deep(.author-avatar:not(:last-child)) {
  margin-left: -10px;
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
