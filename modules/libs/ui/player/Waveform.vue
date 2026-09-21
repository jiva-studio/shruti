<script setup lang="ts">
import { computed, useTemplateRef } from "vue"
import { buildChapterSeparators, type Chapter } from "./buildChapterSeparators.js"

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

const sepByIndex = computed(() =>
  buildChapterSeparators(
    props.peaks.length,
    props.chapters,
    props.durationMs ?? 0,
    props.positionMs ?? 0
  )
)

const barStyles = computed(() => props.peaks.map((h) => ({ height: `${h}%` })))
const sepStyles = computed(() => props.peaks.map((h) => ({ "--sep-h": `${h}%` })))
</script>

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
        :style="sepStyles[i]"
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
        :style="barStyles[i]"
      />
    </template>
  </div>
</template>

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
