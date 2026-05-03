<template>
  <SectionBadge v-if="value > 0" :title="t('activity.completedLectures')">
    <CheckDoubleIcon />
    {{ value }}
  </SectionBadge>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { SectionBadge } from "@ui/primitives/index.js"
import { CheckDoubleIcon } from "@ui/icons/index.js"

defineProps<{
  value: number
}>()

const { t } = useI18n()
</script>
