<script setup lang="ts">
import { ref, nextTick, watch, provide, computed } from 'vue'
import { useT } from '../../i18n/ui'
import ChatMessageBody from './ChatMessageBody.vue'
import ChatMessageActions from './ChatMessageActions.vue'
import WebAuthBar from './WebAuthBar.vue'
import StoreBadges from './StoreBadges.vue'
import SparkleIcon from './icons/SparkleIcon.vue'
import RetryIcon from './icons/RetryIcon.vue'
import NewChatIcon from './icons/NewChatIcon.vue'
import CloseIcon from './icons/CloseIcon.vue'
import ChatDots from './icons/ChatDots.vue'
import { OPEN_TRACK } from './injection'
// Real reused chat primitives (status label via prop, spinner via slot).
import StatusPill from '@lib/ui/chat/StatusPill.vue'
import ChatComposer from '@lib/ui/chat/ChatComposer.vue'
import { webLocale } from '../../lib/i18n'
import { useChatStream, type Msg } from '../../composables/useChatStream'
import { useChatHistory } from '../../composables/useChatHistory'
import { useWebAuth } from '../../composables/useWebAuth'
import { contentLangFor, type Lang } from '../../i18n/locales'

const props = defineProps<{ lang: Lang }>()
// Reused chat cards carry their own ru/en i18n — collapse uk→ru, sr→en.
const cl = contentLangFor(props.lang)
webLocale.value = cl

const BACKEND_FALLBACK = 'https://api.shruti.local'
const AUTH = (import.meta.env.PUBLIC_AUTH_API_URL as string | undefined)?.replace(/\/$/, '') || BACKEND_FALLBACK
const CHAT = (import.meta.env.PUBLIC_CHAT_API_URL as string | undefined)?.replace(/\/$/, '') || BACKEND_FALLBACK
const FREE_TURNS = 10

const auth = useWebAuth({
  authBase: AUTH,
  googleClientId: import.meta.env.PUBLIC_GOOGLE_CLIENT_ID as string | undefined,
  appleServicesId: import.meta.env.PUBLIC_APPLE_SERVICES_ID as string | undefined,
  appleRedirectUri: import.meta.env.PUBLIC_APPLE_REDIRECT_URI as string | undefined,
  locale: cl,
})

// No left library panel here → a track card can't open in-place. Send the
// reader to the full lecture page instead (same route WebApp pushes to).
provide(OPEN_TRACK, (trackId: string) => {
  const slug = trackId.replace(/^track_/, '')
  window.location.href = `/${cl}/app/${slug}`
})

const t = useT(props.lang)
// This surface is the "Ask Sadhu" chat, not the "Shruti" library, so
// it carries its own brand/tagline (ai.* keys) rather than the site name or the
// embedded widget's copy.
const L = {
  brand: t('ai.brand'),
  title: t('ai.brand'),
  sub: t('ai.sub'),
  getApp: t('ai.getApp'),
  placeholder: t('chat.widget.placeholder'),
  send: t('chat.widget.send'),
  stop: t('chat.widget.stop'),
  newChat: t('ai.newChat'),
  delete: t('ai.delete'),
  left: (n: number) => t('chat.widget.left').replace('{n}', String(n)),
  capTitle: t('chat.widget.capTitle'),
  capBody: t('chat.widget.capBody'),
  capGuestTitle: t('ai.capGuestTitle'),
  capGuestBody: t('ai.capGuestBody'),
  retry: t('ai.retry'),
  errTitle: t('ai.errTitle'),
  errBody: t('ai.errBody'),
  suggestions: [t('chat.suggest.1'), t('chat.suggest.2'), t('chat.suggest.3')],
}

const STATUS: Record<string, string> = {
  thinking: t('chat.status.thinking'),
  router_decision: t('chat.status.router_decision'),
  searching_corpus: t('chat.status.searching_corpus'),
  browsing_catalog: t('chat.status.browsing_catalog'),
  locating: t('chat.status.locating'),
  preparing_action: t('chat.status.preparing_action'),
  composing_answer: t('chat.status.composing_answer'),
  synthesizing_answer: t('chat.status.synthesizing_answer'),
}

const scroller = ref<HTMLElement>()

async function scrollDown() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}

const { messages, busy, turns, srvLimit, failed, capped, left, send: sendStream, stop, resetLimits } = useChatStream({
  chatBase: CHAT,
  lang: props.lang,
  freeTurns: FREE_TURNS,
  onScroll: scrollDown,
})

const started = computed(() => messages.value.length > 0)
const signedIn = computed(() => auth.signedIn.value)

// Persisted conversation history (localStorage), namespaced per content language
// so a ru session and an en session don't interleave.
const { chats, currentId, newChat, openChat, deleteChat } = useChatHistory(messages, {
  storageKey: `lts.ai.chats.v1.${cl}`,
  busy,
})

// Sign-in / sign-out swaps the rate-limit bucket; drop any anonymous cap so
// the next turn re-reads the signed-in user's real limits from the server.
watch(() => auth.session.value?.quotaId, () => resetLimits())

const lastQuestion = ref('')
function send(text: string) {
  lastQuestion.value = text
  sendStream(text)
}

// After a network failure the un-answered user turn stays in the transcript;
// drop it so a resend doesn't duplicate the question bubble.
function retry() {
  const q = lastQuestion.value
  if (!q || busy.value) return
  if (messages.value[messages.value.length - 1]?.role === 'user') messages.value.pop()
  send(q)
}

// Switching/clearing conversations mid-stream is unsafe: the in-flight turn
// holds a reference into the current transcript and may pop its trailing
// placeholder. So if a turn is streaming, abort it and defer the switch until
// send() has fully settled (busy → false).
let pending: (() => void) | null = null
function runOrDefer(fn: () => void) {
  if (busy.value) {
    stop()
    pending = fn
  } else {
    fn()
  }
}
watch(busy, (b) => {
  if (!b && pending) {
    const fn = pending
    pending = null
    fn()
  }
})

function onNewChat() {
  runOrDefer(newChat)
}
function onOpenChat(id: string) {
  runOrDefer(() => openChat(id))
}

function statusLabelFor(m: Msg): string {
  return STATUS[m.statusKey ?? ''] ?? STATUS.thinking
}
</script>

<template>
  <div class="flex h-[100dvh] flex-col bg-cream md:flex-row">
    <!-- Mobile top bar: logo + auth (the desktop rail is hidden on phones). -->
    <div class="flex items-center justify-between border-b border-line px-4 py-2 md:hidden">
      <a :href="`/${props.lang}/`" class="flex items-center gap-2 font-serif text-lg font-bold text-ink">
        <img src="/app-icon.png" :alt="L.brand" width="28" height="28" class="h-7 w-7 rounded-lg" />
        <span>{{ L.brand }}</span>
      </a>
      <div class="flex items-center gap-2">
        <a
          :href="`/${props.lang}/#download`"
          class="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-cream text-ink-soft transition hover:border-saffron hover:text-saffron"
          :aria-label="L.getApp"
          :title="L.getApp"
        >
          <svg viewBox="0 0 24 24" class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
        </a>
        <button
          type="button"
          class="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-cream text-ink-soft transition hover:border-saffron hover:text-saffron"
          :aria-label="L.newChat"
          @click="onNewChat"
        >
          <NewChatIcon class="h-[18px] w-[18px]" />
        </button>
        <WebAuthBar :lang="props.lang" />
      </div>
    </div>

    <!-- Left rail: logo top, new chat, auth pinned bottom-left (ChatGPT-style) -->
    <aside class="hidden w-64 flex-col border-r border-line bg-cream-deep/40 md:flex">
      <a :href="`/${props.lang}/`" class="flex items-center gap-2 px-4 pb-2 pt-4 font-serif text-lg font-bold text-ink">
        <img src="/app-icon.png" :alt="L.brand" width="32" height="32" class="h-8 w-8 rounded-lg" />
        <span class="whitespace-nowrap">{{ L.brand }}</span>
      </a>
      <div class="flex min-h-0 flex-1 flex-col p-3">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink-soft transition hover:bg-cream hover:text-saffron"
          @click="onNewChat"
        >
          <NewChatIcon class="h-[18px] w-[18px]" />
          {{ L.newChat }}
        </button>

        <!-- Past conversations (persisted in localStorage) -->
        <ul v-if="chats.length" class="mt-2 min-h-0 flex-1 list-none space-y-0.5 overflow-y-auto p-0">
          <li v-for="c in chats" :key="c.id">
            <div
              class="group flex items-center gap-1 rounded-lg transition"
              :class="c.id === currentId ? 'bg-saffron/15' : 'hover:bg-cream'"
            >
              <button
                type="button"
                class="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm text-ink-soft"
                @click="onOpenChat(c.id)"
              >{{ c.title }}</button>
              <button
                type="button"
                class="mr-1 shrink-0 rounded p-1 text-medium opacity-0 transition hover:text-crimson focus:opacity-100 group-hover:opacity-100"
                :aria-label="L.delete"
                @click.stop="deleteChat(c.id)"
              >
                <CloseIcon class="h-[15px] w-[15px]" />
              </button>
            </div>
          </li>
        </ul>
      </div>
      <div class="space-y-1 p-3">
        <a
          :href="`/${props.lang}/#download`"
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink-soft transition hover:bg-cream hover:text-saffron"
        >
          <svg viewBox="0 0 24 24" class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          {{ L.getApp }}
        </a>
        <WebAuthBar :lang="props.lang" placement="up" />
      </div>
    </aside>

    <!-- Chat column -->
    <div class="relative flex min-w-0 flex-1 flex-col">
      <!-- Empty state: centered greeting + composer + prompt chips -->
      <div v-if="!started" class="flex flex-1 flex-col items-center justify-center px-4">
        <div class="w-full max-w-2xl">
          <h1 class="text-center font-serif text-3xl font-bold text-ink sm:text-4xl">{{ L.title }}</h1>
          <p class="mx-auto mt-3 max-w-md text-center text-sm text-medium">{{ L.sub }}</p>
          <div class="mt-7">
            <ChatComposer
              :sending="busy"
              :placeholder="L.placeholder"
              :send-aria-label="L.send"
              @send="send"
              @cancel="stop"
            >
              <template #spinner><ChatDots /></template>
            </ChatComposer>
          </div>
          <div class="mt-5 flex flex-wrap justify-center gap-2">
            <button
              v-for="s in L.suggestions"
              :key="s"
              class="rounded-full border border-line bg-cream px-4 py-2 text-sm text-ink-soft transition hover:border-saffron hover:text-saffron"
              @click="send(s)"
            >{{ s }}</button>
          </div>
        </div>
      </div>

      <!-- Conversation: transcript scrolls, composer migrates to the bottom -->
      <template v-else>
        <div ref="scroller" class="app-scroll flex-1 space-y-5 overflow-y-auto px-4 pb-32 pt-6">
          <div class="mx-auto max-w-2xl space-y-5">
            <div v-for="(m, idx) in messages" :key="idx">
              <!-- user: right-aligned bubble -->
              <div v-if="m.role === 'user'" class="flex justify-end">
                <div class="max-w-[86%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-saffron px-4 py-2.5 text-[0.95rem] leading-snug text-cream">{{ m.text }}</div>
              </div>
              <!-- assistant: full-width prose, no bubble -->
              <div v-else class="text-[0.95rem] text-ink">
                <ChatMessageBody v-if="m.text" :text="m.text" :lang="props.lang" :verses="m.verses" :chapters="m.chapters" :cites="m.cites" :cards="m.cards" :commentaries="m.commentaries" :media="m.media" :outlines="m.outlines" :pdf-actions="m.pdfActions" />
                <StatusPill
                  v-if="m.streaming"
                  :class="m.text ? 'mt-3' : ''"
                  :status-label="statusLabelFor(m)"
                  :research-questions="m.researchQuestions"
                  :research-sources="m.researchSources"
                >
                  <template #spinner><ChatDots /></template>
                </StatusPill>
                <ChatMessageActions v-if="m.text && !m.streaming" :msg="m" :lang="cl" :chat-base="CHAT" />
              </div>
            </div>

            <!-- Guest hit the free cap → sign in for more (checked before the
                 install card because a 429 sets both `capped` and `failed`). -->
            <div v-if="capped && !signedIn" class="flex flex-col items-center py-8 text-center">
              <span class="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-saffron/12 text-saffron">
                <SparkleIcon class="h-[22px] w-[22px]" />
              </span>
              <p class="font-serif text-lg font-bold text-ink">{{ L.capGuestTitle }}</p>
              <p class="mt-1.5 max-w-xs text-sm text-medium">{{ L.capGuestBody }}</p>
              <div class="mt-5 w-full max-w-[13rem]">
                <WebAuthBar :lang="props.lang" placement="up" />
              </div>
            </div>

            <!-- Signed in but out of quota → continue in the app. -->
            <div v-else-if="capped" class="flex flex-col items-center py-8 text-center">
              <span class="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-saffron/12 text-saffron">
                <SparkleIcon class="h-[22px] w-[22px]" />
              </span>
              <p class="font-serif text-lg font-bold text-ink">{{ L.capTitle }}</p>
              <p class="mt-1.5 max-w-sm text-sm text-medium">{{ L.capBody }}</p>
              <StoreBadges class="mt-5" />
              <a :href="`/${props.lang}/subscribe`" class="mt-4 inline-block text-sm font-semibold text-saffron transition hover:underline">{{ t('sub.cta') }}</a>
            </div>

            <!-- Transient network error → let the reader retry the last turn. -->
            <div v-else-if="failed" class="flex flex-col items-center py-8 text-center">
              <span class="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-line/60 text-medium">
                <RetryIcon class="h-[22px] w-[22px]" />
              </span>
              <p class="font-serif text-base font-semibold text-ink">{{ L.errTitle }}</p>
              <p class="mt-1.5 max-w-sm text-sm text-medium">{{ L.errBody }}</p>
              <button type="button" class="mt-4 inline-flex items-center gap-2 rounded-lg bg-saffron px-5 py-2.5 text-sm font-semibold text-cream transition hover:bg-saffron-shade" @click="retry">
                <RetryIcon class="h-4 w-4" />
                {{ L.retry }}
              </button>
            </div>
          </div>
        </div>

        <!-- Floating composer: overlays the transcript (which scrolls behind it)
             with a cream gradient fade, mirroring the app's floating input bar. -->
        <div class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-cream via-cream/95 to-transparent px-3 pb-4 pt-10">
          <div class="pointer-events-auto mx-auto max-w-2xl">
            <p v-if="!capped && (srvLimit !== null || turns > 0)" class="mb-2 text-center text-xs text-medium">{{ L.left(left) }}</p>
            <ChatComposer
              :sending="busy"
              :disabled="capped"
              :placeholder="L.placeholder"
              :send-aria-label="L.send"
              @send="send"
              @cancel="stop"
            >
              <template #spinner><ChatDots /></template>
            </ChatComposer>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
