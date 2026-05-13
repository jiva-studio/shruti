<template>
  <span ref="anchor" class="anchor" aria-hidden="true" />
  <FloatingChip :position-top="positionTop" :visible="!!curSpeaker">
    {{ curSpeaker }}:
  </FloatingChip>
</template>

<script setup lang="ts">
import { inject, onUnmounted, ref, useTemplateRef, type Ref } from "vue"
import { FloatingChip } from "@ui/primitives/index.js"

const scrollTop: Ref<number> | undefined = inject("scrollTop")
const positionTop = ref("0px")
const curSpeaker = ref("")
const lastSpeaker = ref("")
let lastEl: HTMLElement | null
// An invisible anchor we render alongside the chip lets us walk up to
// the nearest ion-content / transcript modal at runtime. The ".current"
// search then scopes to that subtree instead of the whole document —
// otherwise a `.current` on a Settings list item or tutorial overlay
// would leak in.
const anchor = useTemplateRef<HTMLElement>("anchor")

function resolveScope(): Element | Document {
  return (
    anchor.value?.closest("ion-content") ??
    (anchor.value?.getRootNode() as Element | null) ??
    document
  )
}

const intervalId = setInterval(() => {
  const scope = resolveScope()
  const currentEl: HTMLElement | null = scope.querySelector(".current")
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

<style scoped>
.anchor {
  display: none;
}
</style>
