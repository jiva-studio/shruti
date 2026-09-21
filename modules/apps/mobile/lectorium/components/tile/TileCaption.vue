<script setup lang="ts">
/**
 * The words along the bottom of a tile, and the scrim that keeps them readable.
 *
 * `overArt` says there is a picture behind them: the scrim appears and the type
 * turns cream. Over the bare floor it stays dark and the scrim stays away.
 */
withDefaults(
  defineProps<{ title?: string; subtitle?: string; errorMessage?: string; overArt?: boolean }>(),
  {
    title: "",
    subtitle: "",
    errorMessage: "",
    overArt: false,
  }
)
</script>

<template>
  <span class="scrim" :class="{ overArt }" aria-hidden="true" />
  <div class="meta" :class="{ overArt }">
    <span class="title">{{ title }}</span>
    <span v-if="errorMessage" class="subtitle error">{{ errorMessage }}</span>
    <span v-else-if="subtitle" class="subtitle">{{ subtitle }}</span>
  </div>
</template>

<style scoped>
/* Fixed espresso tones rather than theme vars, which invert — the overlay has
   to stay legible over any cover. */
.scrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 62%;
  background: linear-gradient(to top, rgba(61, 43, 31, 0.78), rgba(61, 43, 31, 0));
  opacity: 0;
  pointer-events: none;
}

.scrim.overArt {
  opacity: 1;
}

.meta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 18px 10px 9px;
}

.title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--ion-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.subtitle {
  font-size: 11px;
  line-height: 1.25;
  color: var(--ion-color-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtitle.error {
  color: var(--ion-color-danger, #eb445a);
}

.meta.overArt .title {
  color: #fdf6ec;
}

.meta.overArt .subtitle {
  color: rgba(253, 246, 236, 0.82);
}
</style>
