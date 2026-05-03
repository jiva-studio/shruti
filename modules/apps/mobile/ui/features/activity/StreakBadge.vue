<template>
  <SectionBadge v-if="value > 0" accent :title="t('activity.streak')">
    <FlameIcon />
    {{ value }}
  </SectionBadge>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { SectionBadge } from "@ui/primitives/index.js"
import { FlameIcon } from "@ui/icons/index.js"

defineProps<{
  value: number
}>()

const { t } = useI18n()
</script>
