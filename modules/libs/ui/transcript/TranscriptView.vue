<template>
  <div class="transcript-view">
    <template v-for="(group, gi) in groups" :key="gi">
      <h2
        v-if="group.heading"
        class="tx-heading"
        @click="emit('seek', group.headingStartMs ?? group.startMs)"
      >
        {{ group.heading }}
      </h2>
      <p
        class="tx-group"
        :class="{ 'is-active': activeEnabled && isActive(group), 'is-dim': activeEnabled && hasActive && !isActive(group) }"
        @click="emit('seek', group.startMs)"
      >
        <button
          type="button"
          class="tx-time"
          @click.stop="emit('seek', group.startMs)"
        >
          {{ formatTime(group.startMs) }}
        </button>
        <TranscriptBlockText
          v-for="(block, bi) in renderable(group)"
          :key="bi"
          :block="block"
        />
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TranscriptBlock, TranscriptGroup } from '@lib/catalog/types.js'
import TranscriptBlockText from './TranscriptBlockText.vue'

const props = withDefaults(
  defineProps<{
    groups: TranscriptGroup[]
    positionMs: number
    activeEnabled?: boolean
  }>(),
  { activeEnabled: true }
)

const emit = defineEmits<{
  seek: [ms: number]
}>()

const hasActive = computed(() => props.groups.some((g) => isActive(g)))

function isActive(group: TranscriptGroup): boolean {
  return group.startMs <= props.positionMs && props.positionMs <= group.endMs
}

function renderable(group: TranscriptGroup): TranscriptBlock[] {
  return group.blocks.filter((b) => b.type !== 'paragraph')
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
</script>

<style scoped>
.transcript-view {
  font-size: 1.05rem;
  line-height: 1.55;
  color: var(--ion-text-color);
}

.tx-heading {
  font-family: var(--font-serif, serif);
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--ion-text-color);
  margin: 18px 0 8px;
  cursor: pointer;
  scroll-margin-top: 200px;
}

.tx-heading:hover {
  color: var(--ion-color-primary);
}

.tx-group {
  position: relative;
  margin: 0 0 2px;
  padding: 3px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 200ms ease;
  scroll-margin-top: 200px;
}

.tx-group.is-active {
  background: rgba(var(--ion-color-primary-rgb), 0.06);
}

.tx-group:hover {
  background: rgba(var(--ion-color-medium-rgb), 0.06);
}

.tx-time {
  display: inline-block;
  margin-right: 8px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ion-color-primary);
  font-size: 0.78rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  vertical-align: baseline;
}

.tx-time:hover {
  text-decoration: underline;
}
</style>
