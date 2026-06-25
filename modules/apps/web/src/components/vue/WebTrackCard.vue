<template>
  <!-- Whole-lecture tile for a find_track result. Body is the server-resolved
       attribution (web holds no local catalog); absent → nothing to render. -->
  <div v-if="body" class="my-2 rounded-md border border-saffron/30 bg-saffron/5 px-3 py-2">
    <div class="font-semibold leading-snug text-ink">{{ title }}</div>
    <div v-if="metaLine" class="mt-1 text-sm text-medium">{{ metaLine }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CardPayload } from './types/chat'

const props = defineProps<{
  trackId: string
  body?: CardPayload
  language?: string
}>()

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const title = computed(() => str(props.body?.trackTitle) || props.trackId)

const metaLine = computed(() => {
  const parts = [
    str(props.body?.authorName),
    str(props.body?.references?.[0]?.label),
    str(props.body?.trackDate),
  ].filter(Boolean)
  return parts.join(' · ')
})
</script>
