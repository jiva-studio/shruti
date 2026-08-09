<template>
  <div class="spacer" :style="{ height }" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useSearchDock } from "@shruti/composables/useSearchDock.js"

/**
 * The room the docked search field takes out of a scroller. Only the field:
 * the floating player lives on Home, and Home does not use this.
 */
const dock = useSearchDock()

const height = computed(() => (dock.visible.value ? "60px" : "0px"))
</script>

<style scoped>
.spacer {
  width: 100%;
}
</style>
