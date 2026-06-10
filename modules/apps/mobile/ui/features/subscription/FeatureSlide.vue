<template>
  <div class="slide">
    <div class="slide-hero">
      <img class="slide-icon" :src="icon" :alt="title" />
      <div v-if="soon" class="slide-badge">{{ $t("app.soon") }}</div>
    </div>
    <div class="slide-body">
      <h1 class="slide-title">{{ title }}</h1>
      <p class="slide-description">{{ description }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  icon: string
  title: string
  description: string
  soon?: boolean
}>()
</script>

<style scoped>
.slide {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  height: 100%;
  padding: 16px 20px 24px;
  box-sizing: border-box;
}

.slide-hero {
  position: relative;
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 0;
}

.slide-icon {
  width: clamp(160px, 50vw, 240px);
  aspect-ratio: 1 / 1;
  height: auto;
  max-height: 100%;
  /* Source art is a 512×512 square. Locking the aspect ratio and letting
     object-fit letterbox means a height clamp can never stretch or squash it. */
  object-fit: contain;
  display: block;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.08));
}

.slide-badge {
  position: absolute;
  top: 0;
  right: 8px;
  padding: 3px 8px;
  border-radius: 5px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  transform: rotate(-8deg);
}

.slide-body {
  flex: 0 0 auto;
  width: 100%;
  /* Keep the title + description in a readable centred column instead of
     stretching edge-to-edge on a wide window. */
  max-width: 440px;
  margin: 0 auto;
  text-align: center;
}

.slide-title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1.2;
  color: var(--ion-text-color);
}

.slide-description {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
</style>
