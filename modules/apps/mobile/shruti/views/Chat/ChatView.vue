<template>
  <IonPage class="chat-page">
    <div class="chat-fixed-top">
      <div class="chat-top-actions">
        <button
          type="button"
          class="action-btn"
          :aria-label="$t('chat.history')"
          @click="onOpenHistory"
        >
          <IconHistory :size="22" />
        </button>
        <h1 class="chat-title">{{ headerTitle }}</h1>
        <button
          type="button"
          class="action-btn"
          :aria-label="$t('chat.newSession')"
          @click="onNewSession"
        >
          <IconPlus :size="22" />
        </button>
      </div>
    </div>
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
          @pick-chapter="onPickChapter"
          @pick-followup="onSend"
          @send-suggestion="onSend"
          @retry="onRetry"
        />
        <PageSticker v-else image="/chat-empty.png">
          <template #footer>
            <SuggestionChips
              :has-current-track="hasCurrentTrack"
              :has-recent-listening="hasRecentListening"
              @pick="onPickSuggestion"
            />
            <RecentSessions
              :sessions="sessions"
              :unread-ids="unseenProactiveSessionIds"
              @pick="onPickSession"
            />
          </template>
        </PageSticker>
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

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonContent, IonPage, onIonViewWillLeave } from "@ionic/vue"
import { IconHistory, IconPlus } from "@tabler/icons-vue"
import { pauseGroup } from "@shruti/composables/useAudioOrchestrator.js"
import { PageSticker } from "@ui/primitives/index.js"
import ChatMessageList from "./components/ChatMessageList.vue"
import ChatInputBar from "./components/ChatInputBar.vue"
import ChatSessionList from "./components/ChatSessionList.vue"
import RecentSessions from "./components/RecentSessions.vue"
import SuggestionChips from "./components/SuggestionChips.vue"
import ChatSessionHeader from "./components/ChatSessionHeader.vue"
import { useChatController } from "./ChatView.controller.js"

const inputBarRef = ref<InstanceType<typeof ChatInputBar> | null>(null)

const { t } = useI18n()

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

watch(inputFocusToken, () => {
  // Ping from `chatStore.requestInputFocus()` — bring the textarea up
  // so the user can type immediately after the Ask-Sadhu navigation.
  inputBarRef.value?.focus()
})

// Ionic keeps this page mounted in the tab's router outlet, so no
// per-component unmount fires when the user navigates away. Stop any
// inline citation audio on leave so it doesn't keep playing in the
// background. (Session switch is handled in the controller's
// route.query.session watcher.)
onIonViewWillLeave(() => {
  pauseGroup("inline")
})

const headerTitle = computed<string>(() => {
  const active = sessions.value.find((s) => s.id === activeSessionId.value)
  const title = active?.title?.trim()
  return title || t("chat.title")
})
</script>

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

/* Visibility gate while a session is loading + scroll-positioning.
 * `visibility: hidden` keeps the layout (so scrollHeight stays valid
 * and `scrollToBottom` can land at the actual bottom), but no paint
 * leaks through — the user never sees the intermediate "messages at
 * scrollTop=0" frame between message-list render and the IonContent
 * scroll completing. Controller flips `scrollReady` true on the next
 * tick after `await scrollToBottom()` resolves. No transition: any
 * fade would re-introduce a visible movement. */
.chat-scroll.is-loading {
  visibility: hidden;
}

/* Fixed top: opaque cream over the safe area + button row, then a long
 * smooth fade to transparent. Unlike SearchView (which sits over a
 * floating chip and so cuts off sharply) the chat fade lives over
 * scrolling text — a longer, eased gradient lets messages dissolve
 * gently rather than hit a hard band. */
.chat-fixed-top {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  z-index: 10;
  padding-top: env(safe-area-inset-top);
  padding-bottom: 28px;
  pointer-events: none;
  /* Two layered fades:
   *   - subtle dark tint on top (gives a slightly darker opaque area)
   *   - non-linear cream fade — holds near-opaque through the top third,
   *     then eases out smoothly toward transparent. */
  background:
    linear-gradient(to bottom, rgba(0, 0, 0, 0.05) 0%, rgba(0, 0, 0, 0) 100%),
    linear-gradient(
      to bottom,
      rgba(var(--shruti-fade-bg-rgb), 1) 0%,
      rgba(var(--shruti-fade-bg-rgb), 0.95) 35%,
      rgba(var(--shruti-fade-bg-rgb), 0.55) 70%,
      rgba(var(--shruti-fade-bg-rgb), 0) 100%
    );
}

.chat-top-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
}

.chat-top-actions > * {
  pointer-events: auto;
}

.chat-title {
  flex: 1;
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  text-align: center;
  color: var(--ion-text-color);
  /* leave room for the 44px action buttons on either side so the title
   * stays centered relative to the page, not relative to the gap. */
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.action-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 0;
  background: transparent;
  color: var(--ion-text-color);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
}

.action-btn:active {
  background: rgba(var(--ion-color-primary-rgb), 0.12);
}
</style>
