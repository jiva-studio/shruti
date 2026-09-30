<script setup lang="ts">
import FloatingInput from "@lib/ui/input/FloatingInput.vue"
import { FloatingInputDock } from "@ui/primitives/index.js"
import SearchBarAction from "./SearchBarAction.vue"

/**
 * The library tab's search field — the same floating capsule, in the same dock,
 * as the chat composer: the thumb is already there and the results grow upward
 * away from it.
 *
 * Bound live, because the surface searches as the text changes. There is no
 * submit: the magnifier is an indicator, and once there is text it gives its
 * place to the button that empties the field.
 *
 * `.search-row` is the class the e2e helpers locate the field by.
 */
defineProps<{
  placeholder: string
  searchLabel: string
  clearLabel: string
}>()

const text = defineModel<string>({ required: true })
</script>

<template>
  <FloatingInputDock class="search-bar">
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
  </FloatingInputDock>
</template>
