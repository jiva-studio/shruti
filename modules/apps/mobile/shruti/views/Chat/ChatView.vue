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
      <div ref="contentRef" class="chat-scroll">
        <ChatMessageList v-if="hasMessages" :messages="messages" />
        <div v-else class="empty-state">
          <img src="/agent.png" class="empty-icon" alt="" aria-hidden="true" />
          <h2 class="empty-title">{{ $t("chat.emptyStateTitle") }}</h2>
          <p class="empty-message">{{ $t("chat.emptyState") }}</p>
        </div>
      </div>
    </IonContent>
    <ChatInputBar :sending="sending" @send="onSend" />
    <ChatSessionList
      :open="isHistoryOpen"
      :sessions="sessions"
      :active-session-id="activeSessionId"
      @update:open="(v) => (v ? null : onCloseHistory())"
      @pick="onPickSession"
      @delete="onDeleteSession"
    />
  </IonPage>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { IonContent, IonPage } from "@ionic/vue"
import { IconHistory, IconPlus } from "@tabler/icons-vue"
import ChatMessageList from "./components/ChatMessageList.vue"
import ChatInputBar from "./components/ChatInputBar.vue"
import ChatSessionList from "./components/ChatSessionList.vue"
import { useChatController } from "./ChatView.controller.js"

const { t } = useI18n()

const {
  messages,
  sessions,
  activeSessionId,
  sending,
  isHistoryOpen,
  hasMessages,
  contentRef,
  onSend,
  onNewSession,
  onOpenHistory,
  onCloseHistory,
  onPickSession,
  onDeleteSession,
} = useChatController()

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

/* flex:1 makes the empty-state stretch to fill the IonContent's
 * available vertical space, then center its children inside it. With
 * chat-scroll being a column-flex container, this guarantees the icon +
 * title + message land in the geometric middle of the chat viewport,
 * regardless of header / input-bar padding. */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  text-align: center;
}

.empty-icon {
  width: 60vw;
  height: auto;
  margin-bottom: 20px;
  opacity: 0.95;
}

.empty-title {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 6px;
  color: var(--ion-text-color);
}

.empty-message {
  font-size: 14px;
  color: var(--ion-color-step-500, #8a8a8a);
  margin: 0;
  max-width: 280px;
}
</style>
