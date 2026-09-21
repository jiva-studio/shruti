<script setup lang="ts">
import { computed } from "vue"
import HelpMarkdown from "./HelpMarkdown.vue"
import { findHelpPage, type HelpPageId } from "./pages/manifest.js"

const props = defineProps<{
  id: HelpPageId
}>()

const page = computed(() => findHelpPage(props.id))
</script>

<template>
  <div v-if="page" class="help-page">
    <HelpMarkdown v-if="page.type === 'markdown'" :locales="page.locales" />
    <component v-else :is="page.component" />
  </div>
</template>
