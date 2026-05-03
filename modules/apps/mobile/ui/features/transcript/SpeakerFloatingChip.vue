<template>
  <FloatingChip :position-top="positionTop" :visible="!!curSpeaker">
    {{ curSpeaker }}:
  </FloatingChip>
</template>

<script setup lang="ts">
import { inject, onUnmounted, ref, type Ref } from "vue"
import { FloatingChip } from "@ui/primitives/index.js"

const scrollTop: Ref<number> | undefined = inject("scrollTop")
const positionTop = ref("0px")
const curSpeaker = ref("")
const lastSpeaker = ref("")
let lastEl: HTMLElement | null

const intervalId = setInterval(() => {
  const currentEl: HTMLElement | null = document.querySelector(".current")
  if (currentEl) {
    const speaker = currentEl.getAttribute("data-speaker")
    // Filter out collapsed rects (e.g. <br> elements in Safari return
    // zero-width rects alongside the real text rect).
    const top = Math.min(
      ...Array.from(currentEl.getClientRects())
        .filter((x) => x.width > 0)
        .map((x) => x.top)
    )

    curSpeaker.value = speaker || ""
    if (curSpeaker.value !== lastSpeaker.value || currentEl === lastEl) {
      positionTop.value = `${top + (scrollTop?.value || 0)}px`
    }
    lastSpeaker.value = speaker || ""
    lastEl = currentEl
  } else {
    curSpeaker.value = ""
  }
}, 500)

onUnmounted(() => clearInterval(intervalId))
</script>
