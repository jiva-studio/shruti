<!--
  Docks a floating input to the bottom of the box its parent positions — the
  tabs' page area, which ends at the tab bar. Ionic hides the tab bar while the
  keyboard is up and the WebView shrinks to the keyboard's edge, so the same box
  then ends at the keyboard: there is no inset to track here.
-->
<template>
  <div class="floating-input-dock">
    <slot />
  </div>
</template>

<style scoped>
.floating-input-dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 8px 12px;
  background: transparent;
  pointer-events: none;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-end;
}
</style>
