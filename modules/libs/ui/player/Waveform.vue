<template>
  <div ref="waveformEl" class="waveform" @click="emit('seek', $event)">
    <template v-for="(h, i) in peaks" :key="i">
      <button
        v-if="sepByIndex.get(i)"
        type="button"
        class="bar sep"
        :class="{
          'is-active': sepByIndex.get(i)!.active,
          'is-played': i / peaks.length < progressFraction,
        }"
        :style="{ '--sep-h': h + '%' }"
        :aria-label="sepByIndex.get(i)!.title"
        :title="sepByIndex.get(i)!.title"
        @click.stop="emit('chapter-seek', sepByIndex.get(i)!.startMs)"
        @mouseenter="emit('chapter-hover', sepByIndex.get(i)!.title)"
        @mouseleave="emit('chapter-hover', null)"
      />
      <span
        v-else
        class="bar"
        :class="{ 'is-played': i / peaks.length < progressFraction }"
        :style="{ height: h + '%' }"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, useTemplateRef } from "vue"

interface Chapter {
  title: string
  startMs: number
  endMs: number
}

interface Sep {
  title: string
  startMs: number
  active: boolean
}

const props = defineProps<{
  peaks: readonly number[]
  progressFraction: number
  chapters?: readonly Chapter[]
  durationMs?: number
  positionMs?: number
}>()

const emit = defineEmits<{
  seek: [event: MouseEvent]
  "chapter-seek": [ms: number]
  "chapter-hover": [title: string | null]
}>()

const waveformEl = useTemplateRef<HTMLDivElement>("waveformEl")
defineExpose({ waveformEl })

const sepByIndex = computed(() => {
  const map = new Map<number, Sep>()
  const chapters = props.chapters
  const n = props.peaks.length
  const dur = props.durationMs ?? 0
  if (!chapters || chapters.length === 0 || n <= 1 || dur <= 0) return map

  let activeIdx = -1
  const pos = props.positionMs ?? 0
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].startMs <= pos) activeIdx = i
    else break
  }

  for (let i = 0; i < chapters.length; i++) {
    let f = chapters[i].startMs / dur
    if (f < 0) f = 0
    if (f > 1) f = 1
    const barIdx = Math.round(f * (n - 1))
    if (barIdx <= 0) continue
    map.set(barIdx, {
      title: chapters[i].title,
      startMs: chapters[i].startMs,
      active: i === activeIdx,
    })
  }
  return map
})
</script>

<style scoped>
.waveform {
  position: relative;
  flex: 1;
  height: var(--waveform-height, 24px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  overflow: visible;
  cursor: pointer;
}

.bar {
  display: inline-block;
  flex: 0 0 2px;
  width: 2px;
  min-height: 2px;
  background: var(--waveform-base, rgba(var(--ion-color-medium-rgb), 0.35));
  border-radius: 2px;
  transition:
    background-color 300ms ease,
    height 350ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.bar.is-played {
  background: var(--waveform-played, var(--ion-color-medium));
}

.bar.sep {
  height: var(--sep-h, 100%);
  padding: 0;
  border: none;
  position: relative;
  cursor: pointer;
  background: rgba(var(--ion-color-tertiary-rgb), 0.5);
  transition:
    background-color 120ms ease,
    height 150ms ease;
  -webkit-tap-highlight-color: transparent;
}

.bar.sep::after {
  content: "";
  position: absolute;
  top: -6px;
  bottom: -6px;
  left: 50%;
  width: 16px;
  transform: translateX(-50%);
}

.bar.sep.is-played {
  background: var(--ion-color-primary-shade);
}

.bar.sep.is-active {
  background: var(--ion-color-primary);
}

.bar.sep:hover {
  height: 100%;
}
</style>
