<template>
  <!-- Web container for the shared TrackCard. Resolves attribution from the
       server `card` payload (web holds no local catalog) and opens the track
       in the left panel on click (provided by WebApp — no chat reload). -->
  <TrackCard
    v-if="body"
    class="web-track-card"
    :title="title"
    :primary-ref="primaryRef"
    :extra-ref-count="extraRefCount"
    :meta-line="metaLine"
    @activate="onActivate"
  />
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import TrackCard from '@lib/ui/chat/TrackCard.vue'
import { OPEN_TRACK } from './injection'
import type { CardPayload } from './types/chat'

const props = defineProps<{
  trackId: string
  body?: CardPayload
  language?: string
}>()

const openTrack = inject(OPEN_TRACK, undefined)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const title = computed(() => str(props.body?.trackTitle) || props.trackId)
const refs = computed(() => props.body?.references ?? [])
const primaryRef = computed(() => str(refs.value[0]?.label))
const extraRefCount = computed(() => Math.max(0, refs.value.length - 1))
const metaLine = computed(() => str(props.body?.trackDate))

function onActivate(): void {
  openTrack?.(props.trackId)
}
</script>

<style scoped>
.web-track-card {
  --lc-accent: var(--color-saffron);
}
</style>
