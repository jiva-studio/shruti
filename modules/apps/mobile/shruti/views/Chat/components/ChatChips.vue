<template>
  <div
    v-if="visible.length"
    class="chat-chips"
    :class="`chat-chips--${align}`"
    :role="ariaLabelKey ? 'list' : undefined"
  >
    <ChatChip
      v-for="(chip, i) in visible"
      :key="i"
      :role="ariaLabelKey ? 'listitem' : undefined"
      :aria-label="ariaLabelKey ? t(ariaLabelKey, { text: chip.label }) : undefined"
      :disabled="disabled"
      @pick="$emit('pick', chip.query)"
    >
      {{ chip.label }}
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
    /** Set while the chat quota lockout is open. Every chip in the row
     *  dispatches a turn on tap, and `sendMessage` refuses one while the
     *  lock is armed — so the row goes visibly dead rather than silently
     *  eating taps. The reason is already on screen: the composer below is
     *  dimmed and the usage chip above it carries the reset time. */
    disabled?: boolean
  }>(),
  { align: "start" }
)

defineEmits<{ pick: [text: string] }>()

const { t } = useI18n()

// A chip is either a plain command (label == what's sent on tap) or the
// `<label>|<query>` form — a SHORT label to show, and the FULL command to send
// when tapped. Split on the first `|` so a chip can read compactly while still
// carrying everything the router needs.
const visible = computed(() =>
  props.items
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => {
      const sep = s.indexOf("|")
      return sep === -1
        ? { label: s, query: s }
        : { label: s.slice(0, sep).trim(), query: s.slice(sep + 1).trim() }
    })
    .filter((c) => c.label.length > 0 && c.query.length > 0)
)
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
