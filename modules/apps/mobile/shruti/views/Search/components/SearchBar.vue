<template>
  <div class="search-bar">
    <div class="search-row">
      <FloatingInput v-model="text" :placeholder="placeholder" :compose-aria-label="placeholder">
        <!-- Search's control. Empty, the magnifier is a label: it says what the
             field is for and does nothing. With text it becomes a cross and
             empties the field. Same button, same place, same colour — only the
             glyph crosses over. -->
        <template #action="{ hasText, clear }">
          <FloatingInputButton
            :label="hasText ? clearLabel : searchLabel"
            @click="hasText ? clear() : undefined"
          >
            <span class="glyphs">
              <svg
                class="glyph"
                :class="{ shown: !hasText }"
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
              <svg
                class="glyph"
                :class="{ shown: hasText }"
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
            </span>
          </FloatingInputButton>
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
 * submit: the magnifier is an indicator, not an action.
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

/* The two glyphs share one cell so neither moves as they trade places. */
.glyphs {
  position: relative;
  display: grid;
  width: 20px;
  height: 20px;
}

.glyph {
  grid-area: 1 / 1;
  opacity: 0;
  transform: scale(0.6) rotate(-45deg);
  transition:
    opacity 140ms ease-out,
    transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.glyph.shown {
  opacity: 1;
  transform: none;
}
</style>
