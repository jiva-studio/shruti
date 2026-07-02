<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useT, type Lang } from '../../i18n/ui'
import { contentLangFor } from '../../i18n/locales'
import { useWebAuth } from '../../composables/useWebAuth'
import { useEmailOtpForm } from '../../composables/useEmailOtpForm'

const props = defineProps<{ lang: Lang; placement?: 'down' | 'up' }>()
const t = useT(props.lang)

// Popover anchor. Default drops down from a top-bar trigger; `up` opens above a
// bottom-of-sidebar trigger (ChatGPT-style left rail on the /ai page).
const menuPos = computed(() =>
  props.placement === 'up' ? 'bottom-full left-0 mb-1' : 'top-full right-0 mt-1'
)
// In the sidebar rail the trigger spans the full column (ChatGPT-style),
// vs. the compact hug-content pill used in the top nav bar.
const isRail = computed(() => props.placement === 'up')

// The rail sits on the cream sidebar, so an outline+cream "Sign in" button
// would vanish into it — use a solid saffron fill there instead.
const signInClass = computed(() =>
  isRail.value
    ? 'flex h-10 w-full items-center justify-center rounded-lg bg-saffron px-4 text-sm font-semibold text-cream transition hover:bg-saffron-shade'
    : 'flex h-9 items-center rounded-lg border border-line bg-cream px-4 text-sm font-semibold text-ink-soft transition hover:border-saffron hover:text-saffron'
)

const BACKEND_FALLBACK = 'https://api.shruti.local'
const AUTH = (import.meta.env.PUBLIC_AUTH_API_URL as string | undefined)?.replace(/\/$/, '') || BACKEND_FALLBACK
const googleClientId = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID as string | undefined
const appleServicesId = import.meta.env.PUBLIC_APPLE_SERVICES_ID as string | undefined

const auth = useWebAuth({
  authBase: AUTH,
  googleClientId,
  appleServicesId,
  appleRedirectUri: import.meta.env.PUBLIC_APPLE_REDIRECT_URI as string | undefined,
  locale: contentLangFor(props.lang),
})

const root = ref<HTMLElement>()
const googleSlot = ref<HTMLElement>()
const open = ref(false)
const busy = ref(false)

const appleEnabled = computed(() => !!appleServicesId)
const googleEnabled = computed(() => !!googleClientId)

// Email OTP sign-in — shared two-step form; close the popover on success.
const {
  step: emailStep,
  email: emailValue,
  code: codeValue,
  busy: emailBusy,
  error: emailError,
  sendCode: onSendCode,
  verify: onVerifyCode,
  changeEmail: onChangeEmail,
} = useEmailOtpForm(auth, t, () => {
  open.value = false
})

const displayName = computed(() => {
  const s = auth.session.value
  return s?.name || s?.email || ''
})
const initial = computed(() => (displayName.value.trim()[0] || '?').toUpperCase())

function mountGoogle() {
  if (googleSlot.value) auth.mountGoogleButton(googleSlot.value, 256)
}

function toggle() {
  open.value = !open.value
  if (open.value) requestAnimationFrame(mountGoogle)
}

async function onApple() {
  busy.value = true
  try {
    if (await auth.signInApple()) open.value = false
  } finally {
    busy.value = false
  }
}

async function onSignOut() {
  open.value = false
  await auth.signOut()
}

function onDocClick(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  // Read-only: show the persisted session if any. The anonymous floor is
  // bootstrapped lazily (chat send / sign-in click), so a site-wide nav
  // button doesn't mint a throwaway anon on every page view.
  auth.hydrate()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div v-if="auth.ready.value" ref="root" class="relative flex items-center" :class="isRail && 'w-full'">
    <template v-if="auth.signedIn.value">
      <button
        type="button"
        class="flex h-9 items-center gap-2 rounded-lg border border-saffron/30 bg-saffron/10 px-3 text-sm text-ink-soft transition hover:border-saffron hover:bg-saffron/15"
        :class="isRail && 'w-full'"
        @click="toggle"
      >
        <span class="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-saffron/20 text-xs font-semibold text-saffron">
          <img v-if="auth.session.value?.picture" :src="auth.session.value.picture" alt="" class="h-full w-full object-cover" />
          <span v-else>{{ initial }}</span>
        </span>
        <span class="hidden max-w-[8rem] truncate sm:inline">{{ displayName }}</span>
        <span
          v-if="auth.isPro.value"
          class="rounded-full bg-saffron px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-cream"
          >Pro</span
        >
      </button>

      <div
        v-if="open"
        class="absolute z-50 w-48 rounded-2xl border border-line bg-cream p-2 shadow-lg"
        :class="menuPos"
      >
        <a
          :href="`/${props.lang}/subscribe`"
          class="block rounded-lg px-3 py-2 text-left text-sm font-semibold text-saffron transition hover:bg-cream-deep"
        >
          {{ t('auth.getPro') }}
        </a>
        <button type="button" class="w-full rounded-lg px-3 py-2 text-left text-sm text-ink-soft transition hover:bg-cream-deep" @click="onSignOut">
          {{ t('auth.signOut') }}
        </button>
      </div>
    </template>

    <template v-else>
      <button type="button" :class="signInClass" @click="toggle">
        {{ t('auth.signIn') }}
      </button>

      <div
        v-if="open"
        class="absolute z-50 w-72 rounded-2xl border border-line bg-cream p-4 shadow-lg"
        :class="menuPos"
      >
        <p class="mb-3 text-center text-xs text-medium">{{ t('auth.cta') }}</p>
        <div v-if="googleEnabled" ref="googleSlot" class="flex justify-center overflow-hidden"></div>
        <button
          v-if="appleEnabled"
          type="button"
          :disabled="busy"
          class="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-cream transition hover:bg-coffee disabled:opacity-60"
          @click="onApple"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M16.36 12.78c.02 2.3 2.02 3.06 2.04 3.07-.02.05-.32 1.1-1.06 2.18-.64.94-1.3 1.87-2.35 1.89-1.02.02-1.35-.6-2.52-.6-1.17 0-1.54.58-2.51.62-1 .04-1.77-1.01-2.42-1.95-1.32-1.92-2.33-5.42-.97-7.78.67-1.18 1.88-1.92 3.19-1.94.99-.02 1.92.66 2.52.66.6 0 1.74-.82 2.93-.7.5.02 1.9.2 2.8 1.52-.07.05-1.67.98-1.65 2.93M14.6 6.16c.53-.64.89-1.53.79-2.42-.76.03-1.69.51-2.24 1.15-.49.56-.92 1.47-.8 2.33.85.07 1.71-.43 2.25-1.06" />
          </svg>
          {{ t('auth.apple') }}
        </button>

        <!-- Passwordless email sign-in -->
        <div
          v-if="googleEnabled || appleEnabled"
          class="my-3 flex items-center gap-3 text-xs uppercase tracking-wide text-medium"
        >
          <span class="h-px flex-1 bg-line"></span>{{ t('auth.email.or') }}<span class="h-px flex-1 bg-line"></span>
        </div>

        <template v-if="emailStep === 'idle'">
          <input
            v-model="emailValue"
            type="email"
            inputmode="email"
            autocomplete="email"
            :placeholder="t('auth.email.placeholder')"
            class="h-10 w-full rounded-lg border border-line bg-cream px-3 text-sm text-ink"
            @keyup.enter="onSendCode"
          />
          <button
            type="button"
            :disabled="emailBusy || !emailValue.trim()"
            class="mt-2 flex h-10 w-full items-center justify-center rounded-lg bg-ink px-4 text-sm font-medium text-cream transition hover:bg-coffee disabled:opacity-60"
            @click="onSendCode"
          >
            {{ emailBusy ? '…' : t('auth.email.sendCode') }}
          </button>
        </template>

        <template v-else>
          <p class="text-sm text-medium">{{ t('auth.email.codeSentTo').replace('{email}', emailValue) }}</p>
          <input
            v-model="codeValue"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            :placeholder="t('auth.email.codePlaceholder')"
            class="mt-2 h-10 w-full rounded-lg border border-line bg-cream px-3 text-center text-base tracking-[0.3em] text-ink"
            @keyup.enter="onVerifyCode"
          />
          <button
            type="button"
            :disabled="emailBusy || codeValue.trim().length < 6"
            class="mt-2 flex h-10 w-full items-center justify-center rounded-lg bg-saffron px-4 text-sm font-semibold text-cream transition hover:bg-saffron-shade disabled:opacity-60"
            @click="onVerifyCode"
          >
            {{ emailBusy ? '…' : t('auth.email.verify') }}
          </button>
          <button type="button" class="mt-2 text-xs text-medium underline" @click="onChangeEmail">
            {{ t('auth.email.changeEmail') }}
          </button>
        </template>

        <p v-if="emailError" class="mt-2 text-sm font-medium text-crimson">{{ emailError }}</p>
      </div>
    </template>
  </div>
</template>
