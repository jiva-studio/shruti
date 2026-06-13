<template>
  <article class="scripture-block"><slot /></article>
</template>

<script setup lang="ts">
// Block frame shared by VerseCard and ChapterCard: soft top + bottom gradient
// rules that fade in from the edges, and adjacent blocks collapse to a single
// shared rule instead of a double-bright line. position:relative so a card's
// own absolutely-positioned bits (e.g. the verse play button) anchor here.
</script>

<style scoped>
.scripture-block {
  position: relative;
  display: block;
  margin: 10px 0;
  padding: 10px 0;
  font-size: 14px;
  line-height: 1.45;
}
.scripture-block::before,
.scripture-block::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.1),
    transparent
  );
  pointer-events: none;
}
.scripture-block::before {
  top: 0;
}
.scripture-block::after {
  bottom: 0;
}
/* Adjacent blocks (several verses / chapters stacked): collapse to one shared
 * rule between them instead of two touching bands. */
.scripture-block + .scripture-block {
  margin-top: 0;
  padding-top: 0;
}
.scripture-block + .scripture-block::before {
  display: none;
}
</style>
