<script setup lang="ts">
import { computed } from "vue"
import { CachedImage } from "@ui/primitives/index.js"

// Fades out over its own height while the cover parallaxes at a slower rate.
const props = defineProps<{
  title: string
  coverUrl?: string
  scrollTop: number
  height: number
}>()

const style = computed(() => ({ opacity: Math.max(0, 1 - props.scrollTop / props.height) }))
const mediaStyle = computed(() => ({ transform: `translateY(${props.scrollTop * 0.4}px)` }))
</script>

<template>
  <div class="hero" :style="style">
    <div class="hero-media" :style="mediaStyle">
      <CachedImage v-if="coverUrl" :url="coverUrl" :alt="title" />
    </div>
    <span class="hero-scrim" aria-hidden="true" />
    <div class="hero-caption">
      <h1 class="hero-title">{{ title }}</h1>
    </div>
  </div>
</template>

<style scoped>
.hero {
  position: relative;
  height: 240px;
  margin-bottom: 8px;
  overflow: hidden;
  background: var(--ion-color-light);
}

.hero-media {
  position: absolute;
  inset: -40px 0;
}

.hero-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(20, 14, 9, 0.55) 0%,
    rgba(20, 14, 9, 0) 26%,
    rgba(20, 14, 9, 0) 50%,
    rgba(20, 14, 9, 0.88) 100%
  );
  pointer-events: none;
}

.hero-caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 16px 16px 14px;
}

.hero-title {
  margin: 0 0 4px;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--shruti-scrim-cream);
}
</style>
