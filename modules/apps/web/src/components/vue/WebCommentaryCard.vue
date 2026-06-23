<template>
  <CommentaryCard
    :body="body"
    :body-html="bodyHtml"
    :is-mt="isMt"
    :show-original="showOriginal"
    @update:show-original="showOriginal = $event"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTranslatable } from '@lib/chat/useTranslatable.js'
import { renderExcerptHtml } from '@lib/chat/chatMarkers.js'
import CommentaryCard from '@lib/ui/chat/CommentaryCard.vue'
import type { CommentaryPayload } from './types/chat'

const props = defineProps<{ body?: CommentaryPayload }>()

const body = computed(() => props.body ?? null)
const { isMt, showOriginal, displayText } = useTranslatable(() => body.value)
const bodyHtml = computed<string>(() => renderExcerptHtml(displayText.value))
</script>
