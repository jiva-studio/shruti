<script setup lang="ts">
import { computed } from "vue"
import { IonContent, IonList, IonModal } from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import ChatHistoryToolbar from "./ChatHistoryToolbar.vue"
import ChatSessionRow from "./ChatSessionRow.vue"
import type { ChatSession } from "@lectorium/stores/useChatStore.js"

const props = defineProps<{
  open: boolean
  sessions: readonly ChatSession[]
  activeSessionId: string | null
  searchQuery: string
  /** Session ids that have an unreplied agent-initiated message —
   *  rendered as a small dot before the title. */
  unreadIds?: ReadonlySet<string>
}>()

const emit = defineEmits<{
  "update:open": [value: boolean]
  "update:searchQuery": [value: string]
  pick: [id: string]
  delete: [id: string]
  "delete-all": []
}>()

// Bridge the parent-owned searchQuery prop to a v-model-compatible
// ref so SearchInput (which uses defineModel) can read/write it.
const bridgedQuery = computed<string>({
  get: () => props.searchQuery,
  set: (v) => emit("update:searchQuery", v),
})

function onPick(id: string): void {
  emit("pick", id)
}

function onDismiss(): void {
  // Reset the search box when the sheet closes so reopening starts from
  // a clean slate; IonModal keeps the DOM around between presentations.
  if (props.searchQuery.length > 0) {
    emit("update:searchQuery", "")
  }
  emit("update:open", false)
}
</script>

<template>
  <IonModal :is-open="open" class="chat-session-list" @did-dismiss="onDismiss">
    <Header>
      <ChatHistoryToolbar
        :can-clear="sessions.length > 0 || searchQuery.length > 0"
        @delete-all="emit('delete-all')"
        @close="emit('update:open', false)"
      />
      <SearchInput v-model="bridgedQuery" :placeholder="$t('chat.searchPlaceholder')" />
    </Header>
    <IonContent>
      <IonList v-if="sessions.length > 0">
        <ChatSessionRow
          v-for="session in sessions"
          :key="session.id"
          :session="session"
          :active="session.id === activeSessionId"
          :unread="unreadIds?.has(session.id) ?? false"
          @pick="onPick(session.id)"
          @delete="$emit('delete', session.id)"
        />
      </IonList>
      <div v-else class="empty">
        {{ searchQuery ? $t("chat.searchEmpty") : $t("chat.historyEmpty") }}
      </div>
    </IonContent>
  </IonModal>
</template>

<style scoped>
.empty {
  padding: 48px 24px;
  text-align: center;
  color: var(--ion-color-step-500, #8a8a8a);
}
</style>

<style>
/* Kill the Material elevation under the toolbar so the sheet reads
   as a flat surface. iOS hairline is already removed by the Header
   primitive's `ion-no-border`. */
.chat-session-list ion-header,
.chat-session-list ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.chat-session-list ion-header::after {
  display: none;
}
</style>
