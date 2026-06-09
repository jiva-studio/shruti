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
          <div class="chat-icon-wrap">
            <IconAppSadhu :size="48" />
            <span v-if="proactiveBadge.count.value > 0" class="proactive-dot" />
          </div>
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
    <!-- Закрывает гэп под ion-tab-bar в зоне safe-area-inset-bottom:
         градиент tab-bar заканчивается на границе safe-area, и без этой
         плашки под ним просвечивает контент страницы. Цвет совпадает
         с нижним стопом градиента (opacity 1.0). -->
    <div class="tab-bar-safe-area-fill" aria-hidden="true" />
  </IonPage>
</template>

<script setup lang="ts">
import { IonTabBar, IonTabButton, IonTabs, IonPage, IonRouterOutlet, IonSpinner } from "@ionic/vue"
import { useRoute, useRouter } from "vue-router"
import { IconHome, IconBookmark, IconSearch, IconSettings } from "@ui/icons/index.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"
import { useChatStore } from "@lectorium/stores/useChatStore.js"
import { useProactiveInboxBadge } from "@lectorium/composables/useProactiveInboxBadge.js"
import IconAppSadhu from "@lectorium/views/Chat/components/IconAppSadhu.vue"

const route = useRoute()
const router = useRouter()
const chat = useChatStore()

/**
 * Tapping the chat tab must ALWAYS reopen the last session; a brand-new chat
 * is started from the header "+" button only.
 *
 * The broken case is a tap on the *already-active* chat tab: Ionic's default
 * then calls `resetTab("chat")`, which walks history back to the tab root
 * (`/tabs/chat`, no `?session=`) — i.e. the empty chat home — bouncing the
 * user off their session onto a blank page. We intercept that one case and
 * re-assert the last session instead. When the chat tab is NOT active we do
 * nothing and let Ionic's `changeTab()` restore the tab's last route (which
 * already lands on the last session).
 *
 * `@click.capture` + `stopImmediatePropagation()` runs before — and fully
 * suppresses — IonTabButton's own bubble-phase click handler (the resetTab
 * path) for this one element.
 */
function onChatTabClick(ev: MouseEvent): void {
  // `route` (injected current-route) is transiently undefined while Ionic
  // tears down / transitions the persistently-mounted TabsLayout, so guard
  // the read — same precaution as the proactive-badge watchers (d027cbe4).
  // Without it, tapping the chat tab to reopen a session throws
  // `Cannot read properties of undefined (reading 'name')`, the reopen
  // (router.replace below) never runs, and the session hangs on a spinner.
  if (route?.name !== "chat") return
  const lastId = chat.activeSessionId ?? chat.sessions[0]?.id ?? null
  if (lastId == null) return // no session yet — let Ionic open the empty home
  ev.stopImmediatePropagation()
  ev.preventDefault()
  const current = typeof route.query.session === "string" ? route.query.session : null
  if (current !== lastId) {
    void router.replace({ name: "chat", query: { session: lastId } })
  }
}

// Tracks the current share job (audio or video). When isRunning flips to
// true we show a small spinner overlay on the bookmark icon — the share
// flow has handed off to background and the user knows something's still
// in flight.
const shareJob = useShareJobStore()

// Sadhu-icon dot. Pure-derived count from chatStore.unseenProactiveSessionIds;
// no watchers needed — opening a session calls `chatStore.openSession`
// which clears the underlying SQL `seen_at` and the derived count
// updates automatically.
const proactiveBadge = useProactiveInboxBadge()
</script>

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

/* The Sadhu icon is rendered at 48px — larger than the 26px Tabler glyphs —
 * so it overflows the tab button's content box. Ionic's native button clips
 * that overflow, cutting the bottom of the icon on iOS (#769). Let the chat
 * tab and its native part render the icon in full. */
.chat-tab-button,
.chat-tab-button::part(native) {
  overflow: visible;
}

/* When the chat tab is active, just bump the disc behind the Sadhu icon
 * a bit brighter — same colour family, no ring, no halo. */
ion-tab-button.chat-tab-button.tab-selected :deep(.app-icon-wrap) {
  background: rgba(var(--ion-color-primary-rgb), 0.28);
}

.chat-icon-wrap {
  position: relative;
  display: inline-block;
}

/* Tiny "unread" dot on the Sadhu icon. No count — a single dot reads
 * cleaner with the round chat-tab disc and avoids tail behaviour when
 * the count overflows two digits. */
.proactive-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ion-color-warning, #ffc409);
  border: 2px solid var(--ion-background-color, #fff);
  pointer-events: none;
}

.tab-bar-safe-area-fill {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: env(safe-area-inset-bottom, 0px);
  background: rgba(var(--lectorium-fade-bg-rgb), 1);
  pointer-events: none;
  /* Ниже ion-tab-bar и FloatingPlayer (~999), выше контента страницы. */
  z-index: 9;
}
</style>

<style>
.badge {
  width: 8px;
  height: 8px;
  position: absolute;
  background-color: var(--ion-color-danger);
  border-radius: 8px;
  top: 12%;
  right: 33%;
}

/* While a background share job runs, the bookmark icon is replaced by
 * a centered spinner of the same visual weight as the icon. Sized to
 * 26px to match IconBookmark; coloured `--ion-color-step-700` so it
 * reads dark against the gradient tab bar (the default primary blue
 * was too pale). v-if/v-else swap in the template means the spinner
 * lands where the icon was — no positioning needed. */
.notes-tab-spinner {
  width: 26px;
  height: 26px;
  color: var(--ion-color-step-700, #4a4a4a);
}
</style>
