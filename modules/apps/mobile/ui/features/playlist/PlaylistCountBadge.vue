<template>
  <SectionBadge v-if="value > 0">
    <HeadphonesIcon />
    {{ value }}
  </SectionBadge>
</template>

<script setup lang="ts">
import { SectionBadge } from "@ui/primitives/index.js"
import { HeadphonesIcon } from "@ui/icons/index.js"

defineProps<{
  value: number
}>()
</script>
