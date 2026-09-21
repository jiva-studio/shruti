<script setup lang="ts">
import { computed } from "vue"
import { CachedImage } from "@ui/primitives/index.js"
import { tintFor } from "./tint.js"

/**
 * What fills a tile's square: the art, or — with none coming — a colour of the
 * tile's own picked from its title, so the same track is the same colour every
 * time and a shelf is not one flat grey wall. While `loading`, a bare shimmer.
 */
const props = withDefaults(
  defineProps<{
    cover?: string | null
    title?: string
    loading?: boolean
    /** Held back while the track is being fetched. */
    dimmed?: boolean
  }>(),
  { cover: null, title: "", loading: false, dimmed: false }
)

const emit = defineEmits<{ loaded: [] }>()

const tinted = computed(() => !props.loading && !props.cover)
const tintStyle = computed(() =>
  tinted.value ? { "--tint-a": tint.value[0], "--tint-b": tint.value[1] } : undefined
)

const tint = computed(() => tintFor(props.title))
</script>

<template>
  <div v-if="loading" class="floor shimmer" aria-hidden="true" />
  <template v-else>
    <div class="floor" :class="{ tinted, dimmed }" :style="tintStyle" aria-hidden="true" />
    <CachedImage v-if="cover" :class="{ dimmed }" :url="cover" @loaded="emit('loaded')" />
  </template>
</template>

<style scoped>
.floor {
  position: absolute;
  inset: 0;
}

.dimmed {
  opacity: 0.85;
}

.tinted {
  background: linear-gradient(150deg, var(--tint-a), var(--tint-b));
}

/* A slow sweep rather than a pulse: "on its way" without pulling the eye off
   the results that already arrived. */
.shimmer {
  background: linear-gradient(
    100deg,
    var(--ion-color-light, #f4f5f8) 30%,
    var(--ion-color-light-shade, #e6e7e9) 50%,
    var(--ion-color-light, #f4f5f8) 70%
  );
  background-size: 300% 100%;
  animation: tile-shimmer 1.4s ease-in-out infinite;
}

@keyframes tile-shimmer {
  from {
    background-position: 150% 0;
  }
  to {
    background-position: -50% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .shimmer {
    animation: none;
  }
}
</style>
