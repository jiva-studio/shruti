<script setup lang="ts">
import { PageSticker } from "@ui/primitives/index.js"
import ChatChips from "./ChatChips.vue"
import RecentSessions from "./RecentSessions.vue"
import type { ChatSession } from "@lectorium/stores/useChatStore.js"

// The screen before a first message: something to ask, and what was asked before.
defineProps<{
  suggestions: readonly string[]
  sessions: readonly ChatSession[]
  unreadIds?: ReadonlySet<string>
  disabled: boolean
}>()

const emit = defineEmits<{ "pick-suggestion": [text: string]; "pick-session": [id: string] }>()
</script>

<template>
  <PageSticker image="/chat-empty.png">
    <template #footer>
      <ChatChips
        class="suggestions"
        :items="suggestions"
        align="center"
        :disabled="disabled"
        @pick="emit('pick-suggestion', $event)"
      />
      <RecentSessions
        :sessions="sessions"
        :unread-ids="unreadIds"
        @pick="emit('pick-session', $event)"
      />
    </template>
  </PageSticker>
</template>

<style scoped>
/* A centred, width-capped block under the sticker; ChatChips owns the row
 * layout, this adds the outer spacing. */
.suggestions {
  margin-top: 14px;
  padding: 0 12px;
  width: 100%;
  max-width: 720px;
}
</style>
