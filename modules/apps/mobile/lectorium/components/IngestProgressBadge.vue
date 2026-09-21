<script setup lang="ts">
import { computed } from "vue"

/**
 * Shared ingest-progress badge — one look for the library card and the chat
 * add-to-library card. A Google-style circular ring that FILLS to `percent`
 * when it is known (the downloading stage), or spins indeterminately for the
 * stages that expose no measure, next to the stage label.
 */
const props = defineProps<{
  /** 0-100 download completion; undefined ⇒ indeterminate spinner. */
  percent?: number
  /** Stage text, e.g. "Downloading 40%" / "Transcribing". */
  label: string
}>()

// r = 9 → circumference; the fill circle's dash offset encodes the percent.
const CIRCUMFERENCE = 2 * Math.PI * 9

const offset = computed(() => {
  const p = Math.max(0, Math.min(100, props.percent ?? 0))
  return (CIRCUMFERENCE * (100 - p)) / 100
})

const ringStyle = computed(() =>
  props.percent !== undefined ? { strokeDashoffset: offset.value } : undefined
)
</script>

<template>
  <span class="ingest-badge" role="status" :aria-label="label">
    <svg class="ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="ring-track" cx="12" cy="12" r="9" />
      <circle
        class="ring-fill"
        :class="{ indeterminate: percent === undefined }"
        cx="12"
        cy="12"
        r="9"
        :style="ringStyle"
      />
    </svg>
    <span class="label">{{ label }}</span>
  </span>
</template>

<style scoped>
.ingest-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  padding: 6px 12px 6px 8px;
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.ring {
  width: 16px;
  height: 16px;
  flex: none;
  /* Start the arc at 12 o'clock and fill clockwise. */
  transform: rotate(-90deg);
}

.ring-track {
  fill: none;
  stroke: rgba(255, 255, 255, 0.25);
  stroke-width: 3;
}

.ring-fill {
  fill: none;
  stroke: #fff;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: 56.549; /* 2πr, r=9 */
  transition: stroke-dashoffset 0.4s linear;
}

/* No measure yet (transcribing / reviewing / storing): a spinning partial arc. */
.ring-fill.indeterminate {
  stroke-dasharray: 14 43;
  stroke-dashoffset: 0;
  transition: none;
  transform-origin: center;
  animation: ingest-spin 0.9s linear infinite;
}

@keyframes ingest-spin {
  to {
    transform: rotate(360deg);
  }
}

/* `min-width: 0` lets the nowrap text shrink below its min-content width, so a
   stage name wider than the pill ends in an ellipsis instead of painting across
   the cover art. The padding widens the clip box past the glyph ink (the cut
   "g" of "Downloading", f6cb6a0b); the equal negative margin keeps the layout. */
.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px;
  margin: -2px;
}
</style>
