<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonContent, IonPage, IonSpinner, onIonViewWillLeave } from "@ionic/vue"
import { pauseGroup } from "@lib/chat/audio/useAudioOrchestrator.js"
import ChatMessageList from "./components/ChatMessageList.vue"
import ChatInputBar from "./components/ChatInputBar.vue"
import ChatSessionList from "./components/ChatSessionList.vue"
import ChatTopBar from "./components/ChatTopBar.vue"
import ChatWelcome from "./components/ChatWelcome.vue"
import ChatSessionHeader from "./components/ChatSessionHeader.vue"
import { useChatController } from "./ChatView.controller.js"
import { useChatSuggestions } from "./composables/useChatSuggestions.js"
import { useIngestStatusPolling } from "@lectorium/composables/useIngestStatusPolling.js"

const inputBarRef = ref<InstanceType<typeof ChatInputBar> | null>(null)

const { t } = useI18n()

// Poll in-flight ingests while chat is open, so an add-to-library candidate
// card shows live stage/percent as its lecture ingests (same poll the library
// views use — it patches the shared store).
useIngestStatusPolling()

const {
  messages,
  sessions,
  activeSessionId,
  sending,
  isHistoryOpen,
  hasMessages,
  hasCurrentTrack,
  hasRecentListening,
  contentRef,
  scrollReady,
  searchQuery,
  filteredSessions,
  unseenProactiveSessionIds,
  loadingFocusIds,
  sessionHeader,
  inputFocusToken,
  isComposeBlocked,
  composeBlockedUntil,
  chatUsage,
  onSend,
  onCancel,
  onNewSession,
  onOpenHistory,
  onCloseHistory,
  onPickSession,
  onDeleteSession,
  onDeleteAllSessions,
  onPickChapter,
  onPickSuggestion,
  onRetry,
} = useChatController()

// Empty-state suggestion chips: a recap plus a shuffled i18n pool.
const { chips: suggestionChips } = useChatSuggestions({
  hasCurrentTrack: () => hasCurrentTrack.value,
  hasRecentListening: () => hasRecentListening.value,
})

// Ping from `chatStore.requestInputFocus()`: bring the textarea up so the user
// can type straight after the Ask-Sadhu navigation.
watch(inputFocusToken, () => {
  inputBarRef.value?.focus()
})

// Ionic keeps this page mounted, so nothing unmounts on navigation: stop the
// inline citation audio here or it plays on in the background.
onIonViewWillLeave(() => {
  pauseGroup("inline")
})

const headerTitle = computed<string>(() => {
  const active = sessions.value.find((s) => s.id === activeSessionId.value)
  const title = active?.title?.trim()
  return title || t("chat.title")
})
</script>

<template>
  <IonPage class="chat-page">
    <ChatTopBar
      :title="headerTitle"
      :can-start-new="hasMessages"
      @open-history="onOpenHistory"
      @new-session="onNewSession"
    />
    <IonContent class="chat-content" :fullscreen="true">
      <div ref="contentRef" :class="['chat-scroll', { 'is-loading': !scrollReady }]">
        <ChatSessionHeader
          v-if="sessionHeader"
          :title="sessionHeader.title"
          :author-name="sessionHeader.authorName"
          :date="sessionHeader.date"
          :location="sessionHeader.location"
        />
        <ChatMessageList
          v-if="hasMessages"
          :messages="messages"
          :loading-focus-ids="loadingFocusIds"
          :quota-locked="isComposeBlocked"
          @pick-chapter="onPickChapter"
          @pick-followup="onSend"
          @send-suggestion="onSend"
          @retry="onRetry"
        />
        <ChatWelcome
          v-else
          :suggestions="suggestionChips"
          :sessions="sessions"
          :unread-ids="unseenProactiveSessionIds"
          :disabled="isComposeBlocked"
          @pick-suggestion="onPickSuggestion"
          @pick-session="onPickSession"
        />
      </div>
      <!-- The scroller is hidden while a session is read and positioned, so
           without this a slow read is a blank screen. -->
      <div v-if="!scrollReady" class="chat-loading" aria-hidden="true">
        <IonSpinner name="crescent" />
      </div>
    </IonContent>
    <ChatInputBar
      ref="inputBarRef"
      :sending="sending"
      :quota-locked="isComposeBlocked"
      :quota-resets-at="composeBlockedUntil"
      :chat-usage="chatUsage"
      @send="onSend"
      @cancel="onCancel"
    />
    <ChatSessionList
      :open="isHistoryOpen"
      :sessions="filteredSessions"
      :active-session-id="activeSessionId"
      :search-query="searchQuery"
      :unread-ids="unseenProactiveSessionIds"
      @update:open="(v) => (v ? null : onCloseHistory())"
      @update:search-query="searchQuery = $event"
      @pick="onPickSession"
      @delete="onDeleteSession"
      @delete-all="onDeleteAllSessions"
    />
  </IonPage>
</template>

<style scoped>
.chat-content {
  --padding-top: calc(var(--ion-safe-area-top, 0px) + 44px);
  /* Room for the absolutely-positioned input bar so the last message
   * never hides under it. Capacitor's native keyboard-resize already
   * shrinks the WebView when the keyboard opens, so we don't need to
   * track keyboard height in JS. */
  --padding-bottom: 64px;
}

.chat-scroll {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

/* `visibility: hidden` keeps the layout, so scrollHeight stays valid and
 * `scrollToBottom` lands at the real bottom, while no intermediate frame is
 * painted. No transition: a fade would put the movement back. */
.chat-scroll.is-loading {
  visibility: hidden;
}

.chat-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>
