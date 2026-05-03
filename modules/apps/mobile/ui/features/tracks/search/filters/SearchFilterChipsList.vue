<template>
  <div class="chip-list-container">
    <slot />
  </div>
</template>

<script setup lang="ts"></script>

<style scoped>
.chip-list-container {
  /* Trailing space at scroll-end uses a `::after` pseudo on `.chips-wrap`
     (SearchFiltersBar.vue) — `padding-right` here and `margin-inline-end`
     on the last chip both drop at scroll-end in mobile WebKit. Both
     edges intentionally sit slightly OUTSIDE the search bar's visible
     border above so the row doesn't look squeezed in. */
  padding-left: 4px;
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
