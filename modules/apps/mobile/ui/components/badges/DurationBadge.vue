<template>
  <SectionBadge :title="title">
    <ClockIcon />
    {{ text }}
  </SectionBadge>
</template>

<script setup lang="ts">
import { SectionBadge } from "@ui/primitives/index.js"
import { ClockIcon } from "@ui/icons/index.js"

defineProps<{
  text: string
  title?: string
}>()
</script>
