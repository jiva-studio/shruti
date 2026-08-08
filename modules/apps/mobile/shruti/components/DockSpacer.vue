<template>
  <div class="spacer" :style="{ height }" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from "vue"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useSearchDock } from "@shruti/composables/useSearchDock.js"

/**
 * The room the chrome docked at the bottom takes out of a scroller: the search
 * field where it is docked, the mini player everywhere else. Never both — the
 * player is hidden wherever the field is, the way it is on chat.
 */
const player = usePlayerStore()
const dock = useSearchDock()

const height = computed(() => {
  if (dock.visible.value) return "60px"
  return player.open ? "var(--kit-page-reserved-space, 0px)" : "0px"
})
</script>

<style scoped>
.spacer {
  width: 100%;
}
</style>
