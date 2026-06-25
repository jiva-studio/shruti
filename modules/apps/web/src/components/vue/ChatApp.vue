<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { STORE, useT } from '../../i18n/ui'
import ChatMessageBody from './ChatMessageBody.vue'
// REAL reused component (decoupled: status label via prop, spinner via slot).
import StatusPill from '@lib/ui/chat/StatusPill.vue'
import ChatComposer from '@lib/ui/chat/ChatComposer.vue'
import { webLocale } from '../../lib/i18n'
import { useChatStream, type Msg } from '../../composables/useChatStream'
import { useWebAuth } from '../../composables/useWebAuth'
import { contentLangFor, type Lang } from '../../i18n/locales'

const props = defineProps<{ lang: Lang; trackId?: string; bare?: boolean }>()
// Reused chat cards carry their own ru/en i18n (lib/i18n) — collapse uk→ru,
// sr→en for them. Widget labels below follow the same collapse.
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
  locale: contentLangFor(props.lang),
})

const t = useT(props.lang)
const L = {
  title: t('chat.widget.title'),
  sub: t('chat.widget.sub'),
  placeholder: props.trackId ? t('chat.widget.placeholderTrack') : t('chat.widget.placeholder'),
  send: t('chat.widget.send'),
  stop: t('chat.widget.stop'),
  left: (n: number) => t('chat.widget.left').replace('{n}', String(n)),
  capTitle: t('chat.widget.capTitle'),
  capBody: t('chat.widget.capBody'),
  errTitle: t('chat.widget.errTitle'),
  errBody: t('chat.widget.errBody'),
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
const input = ref('')

async function scrollDown() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}

const { messages, busy, turns, srvLimit, failed, capped, left, send: sendStream, stop, resetLimits } = useChatStream({
  chatBase: CHAT,
  lang: props.lang,
  trackId: props.trackId,
  freeTurns: FREE_TURNS,
  onScroll: scrollDown,
})

// Sign-in / sign-out swaps the rate-limit bucket; drop any anonymous cap so
// the next turn re-reads the signed-in user's real limits from the server.
watch(() => auth.session.value?.quotaId, () => resetLimits())

function send(text?: string) {
  const q = text ?? input.value
  input.value = ''
  sendStream(q)
}

function statusLabelFor(m: Msg): string {
  return STATUS[m.statusKey ?? ''] ?? STATUS.thinking
}
</script>

<template>
  <div
    class="flex h-full flex-col overflow-hidden"
    :class="bare ? '' : 'rounded-2xl border border-line bg-cream-deep/40'"
  >
    <header v-if="!bare" class="border-b border-line bg-cream/70 px-5 py-4">
      <h2 class="font-serif text-lg font-bold text-ink">{{ L.title }}</h2>
      <p class="text-xs text-medium">{{ L.sub }}</p>
    </header>

    <div ref="scroller" class="app-scroll flex-1 space-y-5 overflow-y-auto px-5 py-5">
      <template v-if="!messages.length">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="s in L.suggestions"
            :key="s"
            class="rounded-full border border-line bg-cream px-4 py-2 text-sm text-ink-soft transition hover:border-saffron hover:text-saffron"
            @click="send(s)"
          >{{ s }}</button>
        </div>
      </template>

      <div v-for="(m, idx) in messages" :key="idx">
        <!-- user: chat bubble, right-aligned -->
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[86%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-saffron px-4 py-2.5 text-[0.95rem] leading-snug text-cream">{{ m.text }}</div>
        </div>
        <!-- assistant: full-width prose, NO bubble (matches the app) -->
        <div v-else class="text-[0.95rem] text-ink">
          <ChatMessageBody v-if="m.text" :text="m.text" :lang="props.lang" :verses="m.verses" :chapters="m.chapters" :cites="m.cites" :commentaries="m.commentaries" :media="m.media" :outlines="m.outlines" :pdf-actions="m.pdfActions" />
          <StatusPill
            v-if="m.streaming"
            :class="m.text ? 'mt-3' : ''"
            :status-label="statusLabelFor(m)"
            :research-questions="m.researchQuestions"
            :research-sources="m.researchSources"
          >
            <template #spinner><span class="dots-spinner" /></template>
          </StatusPill>
        </div>
      </div>

      <!-- graceful fallback / cap → install -->
      <div v-if="failed || capped" class="rounded-2xl border border-saffron/40 bg-saffron/10 p-5 text-center">
        <p class="font-serif text-base font-semibold text-ink">{{ capped ? L.capTitle : L.errTitle }}</p>
        <p class="mt-1 text-sm text-medium">{{ capped ? L.capBody : L.errBody }}</p>
        <div class="mt-4 flex flex-wrap justify-center gap-3">
          <a v-if="capped" :href="`/${props.lang}/subscribe`" class="rounded-lg bg-saffron px-4 py-2 text-sm font-semibold text-cream hover:bg-saffron-shade">{{ t('sub.cta') }}</a>
          <a :href="STORE.appStore" target="_blank" rel="noopener" class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-cream hover:bg-coffee">App Store</a>
          <a :href="STORE.googlePlay" target="_blank" rel="noopener" class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-cream hover:bg-coffee">Google Play</a>
        </div>
      </div>
    </div>

    <footer class="px-3 pb-4 pt-2">
      <p v-if="!capped && (srvLimit !== null || turns > 0)" class="mb-2 text-center text-xs text-medium">{{ L.left(left) }}</p>
      <ChatComposer
        :sending="busy"
        :disabled="capped"
        :placeholder="L.placeholder"
        :send-aria-label="L.send"
        @send="send"
        @cancel="stop"
      >
        <template #spinner><span class="dots-spinner" /></template>
      </ChatComposer>
    </footer>
  </div>
</template>
