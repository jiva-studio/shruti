<template>
  <button type="button" class="collection-row" @click="emit('click')">
    <span class="thumb" :class="{ 'is-placeholder': !coverUrl }">
      <CachedImage :url="coverUrl" :alt="name" />
    </span>
    <span class="text">
      <span class="name">{{ name }}</span>
      <span v-if="description" class="desc">{{ description }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { CachedImage } from "@ui/primitives/index.js"

/**
 * A single collection rendered as a list row (small square cover + name) —
 * the "other collections" list on the Search page, styled to sit alongside
 * the track rows. Cover is served from the local image cache via CachedImage.
 */
defineProps<{
  name: string
  coverUrl?: string
  description?: string
}>()

const emit = defineEmits<{ (e: "click"): void }>()
</script>

<style scoped>
.collection-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  appearance: none;
  border: none;
  background: transparent;
  text-align: left;
  padding: 8px 16px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.collection-row:active {
  background: rgba(var(--ion-color-primary-rgb), 0.06);
}

.thumb {
  position: relative;
  flex: 0 0 auto;
  width: 50px;
  height: 50px;
  border-radius: 9px;
  overflow: hidden;
  background: var(--ion-color-light);
}

.thumb.is-placeholder {
  background: linear-gradient(
    135deg,
    rgba(var(--ion-color-primary-rgb), 0.55),
    rgba(var(--ion-color-tertiary-rgb), 0.7)
  );
}

.text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-size: 15px;
  line-height: 1.3;
  font-weight: 500;
  color: var(--ion-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.desc {
  font-size: 13px;
  line-height: 1.35;
  color: var(--ion-color-medium-shade);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
