<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { STORE } from '../../i18n/ui'
import ChatMessageBody from './ChatMessageBody.vue'
// REAL reused component (decoupled: status label via prop, spinner via slot).
import StatusPill from '@lib/ui/chat/StatusPill.vue'
import ChatComposer from '@lib/ui/chat/ChatComposer.vue'
import { webLocale } from '../../lib/i18n'
import { useChatStream, type Msg } from '../../composables/useChatStream'

type Lang = 'ru' | 'en'
const props = defineProps<{ lang: Lang; trackId?: string; bare?: boolean }>()
webLocale.value = props.lang

const AUTH = (import.meta.env.PUBLIC_AUTH_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const CHAT = (import.meta.env.PUBLIC_CHAT_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const FREE_TURNS = 10

const L = {
  ru: {
    title: 'Спросить Садху',
    sub: 'Анонимно, без регистрации. Спросите о душе, карме или смысле жизни.',
    placeholder: props.trackId ? 'Спросите об этой лекции…' : 'Напишите вопрос…',
    send: 'Спросить',
    stop: 'Стоп',
    left: (n: number) => `Осталось вопросов: ${n}`,
    capTitle: 'Продолжите в приложении',
    capBody: 'Установите «Слушай Садху», чтобы спрашивать без ограничений и слушать лекции целиком.',
    errTitle: 'Чат пока недоступен здесь',
    errBody: 'Полная версия ассистента — в приложении. Установите «Слушай Садху» и спрашивайте без ограничений.',
    suggestions: ['Что такое душа?', 'Зачем нужна карма?', 'В чём смысл жизни?'],
  },
  en: {
    title: 'Ask Sadhu',
    sub: 'Anonymous, no sign-up. Ask about the soul, karma or the meaning of life.',
    placeholder: props.trackId ? 'Ask about this lecture…' : 'Type your question…',
    send: 'Ask',
    stop: 'Stop',
    left: (n: number) => `Questions left: ${n}`,
    capTitle: 'Continue in the app',
    capBody: 'Install Shruti to ask without limits and hear the full lectures.',
    errTitle: 'Chat is not available here yet',
    errBody: 'The full assistant lives in the app. Install Shruti and ask without limits.',
    suggestions: ['What is the soul?', 'Why does karma matter?', 'What is the meaning of life?'],
  },
}[props.lang]

const STATUS: Record<string, string> = props.lang === 'ru'
  ? { thinking: 'Думаю…', router_decision: 'Понимаю вопрос…', searching_corpus: 'Ищу в лекциях…', browsing_catalog: 'Просматриваю каталог…', locating: 'Ищу место…', preparing_action: 'Готовлю ответ…', composing_answer: 'Составляю ответ…', synthesizing_answer: 'Составляю ответ…' }
  : { thinking: 'Thinking…', router_decision: 'Understanding…', searching_corpus: 'Searching the lectures…', browsing_catalog: 'Browsing the catalog…', locating: 'Locating…', preparing_action: 'Preparing…', composing_answer: 'Composing the answer…', synthesizing_answer: 'Composing the answer…' }

const scroller = ref<HTMLElement>()
const input = ref('')

async function scrollDown() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}

const { messages, busy, turns, srvLimit, failed, capped, left, send: sendStream, stop } = useChatStream({
  authBase: AUTH,
  chatBase: CHAT,
  lang: props.lang,
  trackId: props.trackId,
  freeTurns: FREE_TURNS,
  onScroll: scrollDown,
})

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
    :class="bare ? '' : 'rounded-3xl border border-line bg-cream-deep/40'"
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
