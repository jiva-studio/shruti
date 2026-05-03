<template>
  <div class="chip-list-container">
    <slot />
  </div>
</template>

<script setup lang="ts"></script>

<style scoped>
.chip-list-container {
  /* Left padding matches `SearchInputAndroid`'s `.search { margin: 10px }`
     so the first chip's edge lines up with the search field's visible
     border above. Trailing space at scroll-end uses a `::after` pseudo on
     `.chips-wrap` (SearchFiltersBar.vue) — `padding-right` here and
     `margin-inline-end` on the last chip both drop at scroll-end in
     mobile WebKit. The right edge intentionally sits slightly OUTSIDE
     the search bar's visible border so the trailing chip doesn't look
     glued to it. */
  padding-left: 10px;
  width: 100%;
  overflow-x: auto;
  white-space: nowrap;
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.chip-list-container::-webkit-scrollbar {
  display: none;
}
</style>
