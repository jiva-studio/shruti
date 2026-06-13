<template>
  <button type="button" class="collection-card" @click="emit('click')">
    <div class="cover" :class="{ 'cover--placeholder': !coverUrl }">
      <img v-if="coverUrl" :src="coverUrl" :alt="name" loading="lazy" />
    </div>
    <span class="name">{{ name }}</span>
  </button>
</template>

<script setup lang="ts">
/**
 * One collection card for the Search carousel: cover image + name. Dumb /
 * presentational — knows only "tapped". The parent resolves the cover URL and
 * decides what a tap opens. When no cover is set yet (the common case until
 * cover assets are published) it falls back to a cream gradient tile so the
 * card never shows a broken image.
 */
defineProps<{
  name: string
  /** Resolved cover image URL, or undefined to show the placeholder tile. */
  coverUrl?: string
}>()

const emit = defineEmits<{ (e: "click"): void }>()
</script>

<style scoped>
.collection-card {
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 140px;
  flex: 0 0 auto;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  scroll-snap-align: start;
  text-align: left;
}

.cover {
  width: 140px;
  height: 140px;
  border-radius: 14px;
  overflow: hidden;
  background: var(--ion-color-light);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  transition: transform 120ms ease;
}

.collection-card:active .cover {
  transform: scale(0.97);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* No cover yet → warm saffron→coffee tile in the cream palette. */
.cover--placeholder {
  background: linear-gradient(
    135deg,
    rgba(var(--ion-color-primary-rgb), 0.55),
    rgba(var(--ion-color-tertiary-rgb), 0.7)
  );
}

.name {
  font-size: 13px;
  line-height: 1.3;
  color: var(--ion-text-color);
  /* Two-line clamp so long seminar names don't push card heights apart. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
