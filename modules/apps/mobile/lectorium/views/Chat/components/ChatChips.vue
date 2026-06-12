<template>
  <div
    v-if="visible.length"
    class="chat-chips"
    :class="`chat-chips--${align}`"
    :role="ariaLabelKey ? 'list' : undefined"
  >
    <ChatChip
      v-for="(text, i) in visible"
      :key="i"
      :role="ariaLabelKey ? 'listitem' : undefined"
      :aria-label="ariaLabelKey ? t(ariaLabelKey, { text }) : undefined"
      @pick="$emit('pick', text)"
    >
      {{ text }}
    </ChatChip>
  </div>
</template>

<script setup lang="ts">
/**
 * The single chip-list used in chat: empty-state suggestions AND inline
 * follow-ups. Both are a wrapping row of ChatChip buttons emitting `pick`;
 * the only differences are alignment and an optional a11y label, so the
 * caller passes those as props instead of forking into a second component.
 * Data (which chips, in what order) is the caller's job.
 */
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import ChatChip from "./ChatChip.vue"

const props = withDefaults(
  defineProps<{
    items: readonly string[]
    /** Row alignment. Suggestions center; follow-ups hug the user side. */
    align?: "start" | "center" | "end"
    /** When set, each chip gets `t(ariaLabelKey, { text })` and the row
     *  becomes a list / listitem for screen readers. */
    ariaLabelKey?: string
  }>(),
  { align: "start" }
)

defineEmits<{ pick: [text: string] }>()

const { t } = useI18n()

const visible = computed(() => props.items.filter((s) => typeof s === "string" && s.length > 0))
</script>

<style scoped>
.chat-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chat-chips--start {
  justify-content: flex-start;
}
.chat-chips--center {
  justify-content: center;
}
.chat-chips--end {
  justify-content: flex-end;
}
</style>
