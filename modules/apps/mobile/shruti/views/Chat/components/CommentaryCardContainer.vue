<template>
  <!--
    Host container for the pure CommentaryCard. Owns the translation toggle
    state + the rendered comment HTML the card used to compute internally
    (useTranslatable + renderExcerptHtml). The card stays presentational.
  -->
  <CommentaryCard
    :body="props.body"
    :body-html="bodyHtml"
    :is-mt="isMt"
    :show-original="showOriginal"
    @update:show-original="showOriginal = $event"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useTranslatable } from "@lib/chat/useTranslatable.js"
import { renderExcerptHtml } from "@lib/chat/chatMarkers.js"
import type { ChatCommentaryBody } from "@lib/domain/chatMessage.js"
import CommentaryCard from "@lib/ui/chat/CommentaryCard.vue"

const props = defineProps<{
  body?: ChatCommentaryBody
}>()

const body = computed(() => props.body ?? null)
const { isMt, showOriginal, displayText } = useTranslatable(() => body.value)
const bodyHtml = computed<string>(() => renderExcerptHtml(displayText.value))
</script>
