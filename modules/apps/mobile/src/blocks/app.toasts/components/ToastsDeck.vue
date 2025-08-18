<template>
  <div
    class="root"
    :class="{ 
      'closed': items.length === 0,
      'open': items.length > 0
    }"
  >
    <TransitionGroup
      name="list"
      tag="div"
      class="stack-container"
      @before-leave="onBeforeLeave"
    >
      <div
        v-for="(item, idx) in items"
        :key="item.message"
        class="card"
        :class="`card-${idx}`"
        :data-index="idx"
        @click="emit('remove', idx)"
      >
        {{ item.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  items: { message: string }[]
}>()

const emit = defineEmits<{
  remove: [index: number]
}>()

const onBeforeLeave = (el: Element) => {
  el.classList.add('swipe-up')
}
</script>

<style scoped>
/* Enter/Leave transitions */
.list-enter-active {
  transition: all 0.5s ease;
}

.list-leave-active {
  transition: all 0.5s ease;
}

.list-enter-from {
  opacity: 0;
  transform: translateY(-30px) scale(0.8);
}

.list-leave-to {
  opacity: 0;
  transform: translateY(-60px) scale(0.8);
}

/* Swipe up effect for removing cards */
.swipe-up {
  animation: swipeUp 0.5s ease-out forwards;
}

@keyframes swipeUp {
  0% {
    transform: var(--current-transform, translate3d(0px, 0px, 0px));
    opacity: 1;
  }
  50% {
    transform: translateY(-100px); /* scale(1.1);*/
    opacity: 0.7;
  }
  100% {
    transform: translateY(-200px); /*scale(0.5);*/
    opacity: 0;
  }
}

/* Base styles */
.root {
  z-index: 1000;
  perspective: 1000px;
  margin-top: -80px;
  transition: all 0.25s ease-in-out;
  /* position: sticky; */
  /* background-color: var(--ion-color-light); */
}
.open {
  margin-top: var(--ion-safe-area-top);
  /* padding-bottom: 10px; */
  /* padding-bottom: calc(var(--ion-safe-area-top) * -1); */
}
.closed {
  margin-top: -80px;
}

.stack-container {
  position: relative;
  height: 60px;
  transform-style: preserve-3d;
  margin: 10px;
  perspective: 1000px;
}

.card {
  position: absolute;
  background-color: var(--ion-color-warning);
  /* color: white; */
  width: 100%;
  height: 4rem;
  padding: 5px;
  border-radius: 10px;
  padding: 10px;
  /* Key: smooth transitions between stack positions */
  transition: 
    transform 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94),
    filter 0.6s ease,
    opacity 0.3s ease;
  transform-origin: center center;
}

/* Stack positioning with CSS variables for animation reference */
.card.card-0 {
  --current-transform: translate3d(0px, 0px, 0px);
  transform: var(--current-transform);
  filter: none;
  z-index: 3;
}

.card.card-1 {
  --current-transform: translate3d(0px, 5px, -10px);
  transform: var(--current-transform);
  filter: brightness(.8);
  z-index: 2;
}

.card.card-2 {
  --current-transform: translate3d(0px, 10px, -20px);
  transform: var(--current-transform);
  filter: brightness(.6);
  z-index: 1;
}

/* Higher specificity for cards beyond index 2 */
.card:not(.card-0):not(.card-1):not(.card-2) {
  --current-transform: translate3d(0px, 10px, -20px);
  transform: var(--current-transform);
  filter: brightness(.6);
  z-index: 0;
}

/* Move transition for repositioning */
.list-move {
  transition: all 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
</style>