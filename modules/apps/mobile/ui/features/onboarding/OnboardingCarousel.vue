<template>
  <div class="ob-carousel">
    <!-- Top bar: progress dots (centered) + Skip (right). -->
    <div class="ob-topbar">
      <div class="ob-dots" role="tablist">
        <button
          v-for="i in pageCount"
          :key="i - 1"
          class="ob-dot"
          :class="{ 'ob-dot--active': page === i - 1 }"
          :aria-label="`${i}`"
          @click="goTo(i - 1)"
        />
      </div>
      <IonButton
        v-if="showSkip"
        fill="clear"
        size="small"
        class="ob-skip"
        data-testid="onboarding-skip"
        @click="emit('skip')"
      >
        {{ $t("onboarding.skip") }}
      </IonButton>
    </div>

    <!-- Swipeable viewport. One full-width slide per page. -->
    <div ref="viewportRef" class="ob-viewport" @pointerdown="onPointerDown">
      <div class="ob-track" :style="trackStyle">
        <div v-for="i in pageCount" :key="i - 1" class="ob-slide">
          <slot name="slide" :index="i - 1" :active="page === i - 1" />
        </div>
      </div>
    </div>

    <!-- Bottom actions: the parent fills this with the primary CTA, or the
         subscription footer on the paywall page. -->
    <div class="ob-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { IonButton } from "@ionic/vue"
import { useHorizontalCarousel } from "@ui/components/useHorizontalCarousel.js"

const props = withDefaults(
  defineProps<{
    pageCount: number
    modelValue: number
    showSkip?: boolean
    /** Disable page-swipe (e.g. on the paywall, whose own screenshot strip
     *  would otherwise fight the gesture). Dots still navigate. */
    swipeDisabled?: boolean
  }>(),
  { showSkip: true, swipeDisabled: false }
)

const emit = defineEmits<{
  (e: "update:modelValue", page: number): void
  (e: "skip"): void
}>()

const viewportRef = ref<HTMLElement | null>(null)
const { page, dragOffset, viewportWidth, onPointerDown, goTo } = useHorizontalCarousel({
  pageCount: props.pageCount,
  initialPage: props.modelValue,
  viewportEl: () => viewportRef.value,
  swipeDisabled: () => props.swipeDisabled,
})

watch(page, (p) => emit("update:modelValue", p))
watch(
  () => props.modelValue,
  (p) => {
    if (p !== page.value) goTo(p)
  }
)

const trackStyle = computed(() => {
  const base = viewportWidth.value > 0 ? -(page.value * viewportWidth.value) : 0
  return {
    transform: `translateX(${base + dragOffset.value}px)`,
    transition: dragOffset.value === 0 ? "transform 0.3s ease" : "none",
  }
})
</script>

<style scoped>
.ob-carousel {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
}

.ob-topbar {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 48px;
  padding: 8px 4px 4px;
}

.ob-dots {
  display: flex;
  gap: 8px;
}

.ob-dot {
  width: 8px;
  height: 8px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--ion-color-step-300, #ccc);
  transition:
    background 0.2s ease,
    width 0.2s ease;
  cursor: pointer;
}

.ob-dot--active {
  width: 20px;
  border-radius: 4px;
  background: var(--ion-color-primary);
}

.ob-skip {
  position: absolute;
  right: 4px;
  --color: var(--ion-color-medium);
}

.ob-viewport {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
  min-height: 0;
  touch-action: pan-y;
}

.ob-track {
  display: flex;
  height: 100%;
  will-change: transform;
}

.ob-slide {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.ob-slide::-webkit-scrollbar {
  display: none;
}
/* Vertically centre each screen's content in the viewport; tall content
   (e.g. the value-moment lecture list) still scrolls via the auto margins. */
.ob-slide > * {
  width: 100%;
  margin-block: auto;
}

.ob-actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding: 8px 20px calc(16px + var(--ion-safe-area-bottom, 0px));
}
</style>
