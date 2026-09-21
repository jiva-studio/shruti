<script setup lang="ts">
import FloatingInput from "@lib/ui/input/FloatingInput.vue"
import SearchBarAction from "./SearchBarAction.vue"

/**
 * The library tab's search field — the same floating capsule the chat writes
 * into, docked at the bottom for the same reason: the thumb is already there
 * and the results grow upward away from it.
 *
 * Bound live, because the surface searches as the text changes. There is no
 * submit: the magnifier is an indicator, and once there is text it gives its
 * place to the button that empties the field.
 *
 * `.search-row` is deliberate — it is the class the e2e helpers locate the
 * field by, and it was the class on the field this replaces.
 */
defineProps<{
  placeholder: string
  searchLabel: string
  clearLabel: string
}>()

const text = defineModel<string>({ required: true })
</script>

<template>
  <div class="search-bar">
    <div class="search-row">
      <FloatingInput v-model="text" :placeholder="placeholder" :compose-aria-label="placeholder">
        <template #action="{ hasText, clear }">
          <SearchBarAction
            :has-text="hasText"
            :search-label="searchLabel"
            :clear-label="clearLabel"
            @clear="clear()"
          />
        </template>
      </FloatingInput>
    </div>
  </div>
</template>

<style scoped>
/* Docked at the root, over the page stack: above the floating player (999),
   below Ionic's overlays (~1001). */
.search-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(56px + var(--ion-safe-area-bottom, 0px));
  padding: 8px 12px;
  background: transparent;
  pointer-events: none;
  z-index: 1000;
}
</style>
