<template>
  <div class="search-bar">
    <div class="search-row">
      <FloatingInput v-model="text" :placeholder="placeholder" :compose-aria-label="placeholder">
        <!-- Two buttons in one place, not one button with two glyphs. Empty,
             the magnifier is a label: it says what the field is for and does
             nothing. With text, that button shrinks away and the cross grows in
             to take it — the whole disc animates, which is what makes it read
             as one control becoming another rather than an icon swapping. -->
        <template #action="{ hasText, clear }">
          <span class="buttons">
            <FloatingInputButton
              class="stacked"
              :visible="!hasText"
              :label="searchLabel"
              @click="undefined"
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
            </FloatingInputButton>
            <FloatingInputButton
              class="stacked"
              :visible="hasText"
              :label="clearLabel"
              @click="clear()"
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </FloatingInputButton>
          </span>
        </template>
      </FloatingInput>
    </div>
  </div>
</template>

<script setup lang="ts">
import FloatingInput from "@lib/ui/input/FloatingInput.vue"
import FloatingInputButton from "@lib/ui/input/FloatingInputButton.vue"

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

<style scoped>
/* Floats over the content, the way the chat bar does, so the scroller keeps
   the full height and nothing reflows when the keyboard arrives. */
.search-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 8px 12px;
  background: transparent;
  pointer-events: none;
  z-index: 10;
}

/* The two discs share one cell, so one can shrink away exactly where the other
   grows in and nothing shifts. */
.buttons {
  position: relative;
  display: grid;
  width: 36px;
  height: 36px;
}

.stacked {
  grid-area: 1 / 1;
}
</style>
