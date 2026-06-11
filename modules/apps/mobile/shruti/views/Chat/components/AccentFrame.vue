<template>
  <div class="accent-frame">
    <span class="accent-frame-bar" />
    <div class="accent-frame-content"><slot /></div>
  </div>
</template>

<style scoped>
.accent-frame {
  display: flex;
  background: rgba(var(--ion-color-primary-rgb), 0.06);
  border-radius: 4px;
  overflow: hidden;
}
.accent-frame-bar {
  flex: 0 0 3px;
  background: var(--ion-color-primary);
}
.accent-frame-content {
  flex: 1;
  min-width: 0;
}
</style>
