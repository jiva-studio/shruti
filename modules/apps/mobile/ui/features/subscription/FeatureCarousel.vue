<template>
  <div ref="viewportRef" class="carousel-viewport" @pointerdown="onPointerDown">
    <div class="carousel-track" :class="{ snapping: pointerId === null }" :style="trackStyle">
      <div v-for="(_, i) in pageCount" :key="i" class="carousel-slot">
        <slot :index="i" />
      </div>
    </div>

    <div class="carousel-dots">
      <span
        v-for="(_, i) in pageCount"
        :key="i"
        class="dot"
        :class="{ active: i === page }"
        @click="goTo(i)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useHorizontalCarousel } from "./useHorizontalCarousel.js"

const props = defineProps<{ pageCount: number; initialPage?: number }>()
const emit = defineEmits<{ "update:index": [index: number] }>()

const viewportRef = ref<HTMLElement | null>(null)
const { page, dragOffset, pointerId, onPointerDown, goTo } = useHorizontalCarousel({
  pageCount: props.pageCount,
  initialPage: props.initialPage,
  viewportEl: () => viewportRef.value,
})

watch(page, (v) => emit("update:index", v))
watch(
  () => props.initialPage,
  (v) => {
    if (typeof v === "number") goTo(v)
  }
)

const trackStyle = computed(() => {
  const w = viewportRef.value?.getBoundingClientRect().width ?? 0
  const tx = -page.value * w + dragOffset.value
  return { transform: `translate3d(${tx}px, 0, 0)` }
})
</script>

<style scoped>
.carousel-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: pan-y;
}

.carousel-track {
  display: flex;
  height: 100%;
  will-change: transform;
}

.carousel-track.snapping {
  transition: transform 0.28s ease-out;
}

.carousel-slot {
  flex: 0 0 100%;
  height: 100%;
  min-width: 0;
}

.carousel-dots {
  position: absolute;
  bottom: 12px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  gap: 6px;
  pointer-events: none;
}

.carousel-dots .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ion-color-medium);
  opacity: 0.4;
  transition:
    opacity 0.2s,
    transform 0.2s;
  pointer-events: auto;
  cursor: pointer;
}

.carousel-dots .dot.active {
  opacity: 1;
  transform: scale(1.4);
  background: var(--ion-color-primary);
}
</style>
