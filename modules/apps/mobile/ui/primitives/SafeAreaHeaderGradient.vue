<template>
  <div class="safe-area-header" />
</template>

<style scoped>
.safe-area-header {
  position: fixed;
  left: 0px;
  right: 0px;
  top: 0px;
  height: var(--ion-safe-area-top);
  background: linear-gradient(
    to bottom,
    rgba(var(--shruti-fade-bg-rgb), 1) 0%,
    rgba(var(--shruti-fade-bg-rgb), 0.8) 35%,
    rgba(var(--shruti-fade-bg-rgb), 0) 100%
  );
  z-index: 1;
  pointer-events: none;
}
</style>
