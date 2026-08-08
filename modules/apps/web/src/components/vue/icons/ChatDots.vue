<template>
  <!-- Three pulsing dots — the web mirror of the app's `<IonSpinner name="dots" />`.
       Rendered as an SVG so the parent slot rule `.spinner :deep(*) { width/height: 100% }`
       (StatusPill / FloatingInput) sizes the whole glyph without squishing the dots:
       SVG <circle> geometry comes from cx/cy/r, so the ignored width/height do no harm. -->
  <svg class="chat-dots" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle class="d1" cx="5" cy="12" r="2.4" />
    <circle class="d2" cx="12" cy="12" r="2.4" />
    <circle class="d3" cx="19" cy="12" r="2.4" />
  </svg>
</template>

<style scoped>
.chat-dots {
  display: block;
}
.chat-dots circle {
  opacity: 0.3;
  transform-box: fill-box;
  transform-origin: center;
  animation: chat-dot 1.1s infinite ease-in-out;
}
.chat-dots .d2 {
  animation-delay: 0.18s;
}
.chat-dots .d3 {
  animation-delay: 0.36s;
}
@keyframes chat-dot {
  0%,
  70%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  35% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
