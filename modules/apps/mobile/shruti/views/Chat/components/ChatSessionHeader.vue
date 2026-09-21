<script setup lang="ts">
/**
 * Header rendered above the message list whenever the active session
 * is anchored to a track (i.e. it was opened via "Ask Sadhu"). Tells
 * the user "this conversation is about Lecture X" so the focus cards
 * stay context — author, date, location don't need to be repeated on
 * every focus message.
 *
 * Pure presentation — the parent view hands resolved bibliographic
 * fields. When the track row hasn't loaded yet (cold DB), both
 * `title` and `subtitle` are empty and we render nothing rather than
 * a placeholder "untitled" line.
 */
import { computed } from "vue"

const props = defineProps<{
  title?: string | null
  authorName?: string | null
  date?: string | null
  location?: string | null
}>()

const title = computed<string>(() => props.title?.trim() ?? "")

const subtitle = computed<string>(() => {
  const bits = [props.authorName, props.date, props.location]
    .map((b) => (typeof b === "string" ? b.trim() : ""))
    .filter((b) => b.length > 0)
  return bits.join(" · ")
})

const visible = computed<boolean>(() => title.value.length > 0 || subtitle.value.length > 0)
</script>

<template>
  <div v-if="visible" class="session-header">
    <div class="session-header-line title">{{ title }}</div>
    <div v-if="subtitle" class="session-header-line subtitle">{{ subtitle }}</div>
  </div>
</template>

<style scoped>
.session-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 16px 10px;
  border-bottom: 1px solid rgba(var(--ion-color-medium-rgb), 0.15);
  margin-bottom: 8px;
}

.session-header-line {
  text-align: center;
  line-height: 1.3;
  word-break: break-word;
}

.session-header-line.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ion-text-color);
}

.session-header-line.subtitle {
  font-size: 12px;
  color: var(--ion-color-medium);
}
</style>
