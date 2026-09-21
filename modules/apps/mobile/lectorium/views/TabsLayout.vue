<script setup lang="ts">
import { onMounted } from "vue"
import { IonTabBar, IonTabButton, IonTabs, IonPage, IonRouterOutlet, IonSpinner } from "@ionic/vue"
import { useRouter } from "vue-router"
import { IconHome, IconBookmark, IconSearch, IconSettings } from "@ui/icons/index.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"
import { useProactiveInboxBadge } from "@lectorium/composables/useProactiveInboxBadge.js"
import { useLibraryLandingStore } from "@lectorium/stores/useLibraryLandingStore.js"
import ChatTabIcon from "./components/ChatTabIcon.vue"

const router = useRouter()

// Earliest point both databases are known open: warm the Search landing in the
// background so its covers are cached before the tab is opened. Failures are
// non-fatal.
onMounted(() => {
  void useLibraryLandingStore().ensureLoaded()
})

// The chat tab always opens the chat home. Ionic's own `changeTab()` would
// restore the tab's last route and reopen a session with it, so the click is
// intercepted before it runs.
function onChatTabClick(ev: MouseEvent): void {
  ev.stopImmediatePropagation()
  ev.preventDefault()
  void router.replace({ name: "chat", query: {} })
}

// A share job that has handed off to the background shows as a spinner on the
// bookmark tab.
const shareJob = useShareJobStore()

const proactiveBadge = useProactiveInboxBadge()
</script>

<template>
  <IonPage>
    <IonTabs>
      <IonRouterOutlet />
      <IonTabBar slot="bottom">
        <IonTabButton tab="home" href="/tabs/home">
          <IconHome :size="26" />
        </IonTabButton>

        <IonTabButton tab="search" href="/tabs/search">
          <IconSearch :size="26" />
        </IonTabButton>

        <IonTabButton
          tab="chat"
          href="/tabs/chat"
          class="chat-tab-button"
          @click.capture="onChatTabClick"
        >
          <ChatTabIcon :unread="proactiveBadge.count.value > 0" />
        </IonTabButton>

        <IonTabButton tab="notes" href="/tabs/notes">
          <IonSpinner v-if="shareJob.isInBackground" class="notes-tab-spinner" name="dots" />
          <IconBookmark v-else :size="26" />
        </IonTabButton>

        <IonTabButton tab="settings" href="/tabs/settings">
          <IconSettings :size="26" />
        </IonTabButton>
      </IonTabBar>
    </IonTabs>
    <!-- The tab-bar gradient stops at the safe-area edge; this fills the gap
         below it with the gradient's last stop. -->
    <div class="tab-bar-safe-area-fill" aria-hidden="true" />
  </IonPage>
</template>

<style scoped>
ion-tab-bar {
  --border: 0;
  --background: linear-gradient(
    to bottom,
    rgba(var(--lectorium-fade-bg-rgb), 0) 0%,
    rgba(var(--lectorium-fade-bg-rgb), 0.8) 35%,
    rgba(var(--lectorium-fade-bg-rgb), 1) 100%
  );
  padding-top: 12px;
}

ion-tab-button {
  --ripple-color: rgba(0, 0, 0, 0);
}

/* The 48px Sadhu icon overflows the tab button's content box, and Ionic's
 * native button clips it. */
.chat-tab-button,
.chat-tab-button::part(native) {
  overflow: visible;
}

/* Active chat tab: brighten the disc behind the icon, nothing else. */
ion-tab-button.chat-tab-button.tab-selected :deep(.app-icon-wrap) {
  background: rgba(var(--ion-color-primary-rgb), 0.28);
}

.tab-bar-safe-area-fill {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: env(safe-area-inset-bottom, 0px);
  background: rgba(var(--lectorium-fade-bg-rgb), 1);
  pointer-events: none;
  /* Below the tab bar and the floating player (~999), above page content. */
  z-index: 9;
}

/* Matches IconBookmark's 26px; the step colour reads dark against the
 * gradient tab bar where the default primary blue does not. */
.notes-tab-spinner {
  width: 26px;
  height: 26px;
  color: var(--ion-color-step-700, #4a4a4a);
}
</style>
