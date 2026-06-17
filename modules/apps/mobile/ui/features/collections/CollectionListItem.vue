<template>
  <button type="button" class="collection-row ion-activatable" @click="emit('click')">
    <span class="thumb">
      <CachedImage :url="coverUrl" :alt="name" />
    </span>
    <IonLabel class="text">
      <h3 class="name">{{ name }}</h3>
      <p v-if="description" class="desc">{{ description }}</p>
    </IonLabel>
    <IonRippleEffect />
  </button>
</template>

<script setup lang="ts">
import { IonLabel, IonRippleEffect } from "@ionic/vue"
import { CachedImage } from "@ui/primitives/index.js"

/**
 * A single collection rendered as a list row (small square cover + name) —
 * the "other collections" list on the Search page. Text sits in an IonLabel
 * (h3 + p) so it inherits the same type scale and colours as the track rows
 * it sits alongside. Cover is served from the local image cache via
 * CachedImage over the thumb's light placeholder background.
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
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  appearance: none;
  border: none;
  background: transparent;
  text-align: left;
  padding: 8px 16px;
  overflow: hidden;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.thumb {
  position: relative;
  flex: 0 0 auto;
  width: 57px;
  height: 57px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--ion-color-light);
  box-shadow: 0 1px 4px rgba(var(--ion-color-dark-rgb), 0.12);
}

.text {
  min-width: 0;
  flex: 1;
}

/* Single-line name, two-line description — layout only; type scale and colour
   come from IonLabel's default h3/p styling, matching the track rows. */
.name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
