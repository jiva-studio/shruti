<template>
  <div class="spacer" :style="{ height }" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from "vue"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useSearchDock } from "@shruti/composables/useSearchDock.js"

/**
 * The room the chrome docked at the bottom takes out of a scroller — the mini
 * player, and the search field on the pages that carry it. Both float rather
 * than taking their own space, so the last row has to be told to stop short.
 *
 * Ends any page that scrolls under them. Each part is conditional: typing hides
 * the player (App.vue drops it whenever the keyboard is open), and the reserved
 * space would be a hole at the end of the list.
 */
const player = usePlayerStore()
const dock = useSearchDock()

const height = computed(() => {
  const parts: string[] = []
  if (dock.visible.value) parts.push("60px")
  if (player.open) parts.push("var(--kit-page-reserved-space, 0px)")
  return parts.length ? `calc(${parts.join(" + ")})` : "0px"
})
</script>

<style scoped>
.spacer {
  width: 100%;
}
</style>
