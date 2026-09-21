<script setup lang="ts">
import { computed } from "vue"
import { useSearchDock } from "@lectorium/composables/useSearchDock.js"

/**
 * The room the docked search field takes out of a scroller. Only the field:
 * the floating player lives on Home, and Home does not use this.
 */
const dock = useSearchDock()

const spacerStyle = computed(() => ({ height: dock.visible.value ? "60px" : "0px" }))
</script>

<template>
  <div class="spacer" :style="spacerStyle" aria-hidden="true" />
</template>

<style scoped>
.spacer {
  width: 100%;
}
</style>
