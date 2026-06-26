<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { STORE, useT, type Lang } from '../../i18n/ui'
import { contentLangFor } from '../../i18n/locales'
import { useWebAuth } from '../../composables/useWebAuth'
import { useEmailOtpForm } from '../../composables/useEmailOtpForm'

const props = defineProps<{ lang: Lang }>()
const t = useT(props.lang)

const BACKEND_FALLBACK = 'https://api.shruti.local'
const AUTH = (import.meta.env.PUBLIC_AUTH_API_URL as string | undefined)?.replace(/\/$/, '') || BACKEND_FALLBACK
const BILLING = (import.meta.env.PUBLIC_BILLING_API_URL as string | undefined)?.replace(/\/$/, '') || BACKEND_FALLBACK
const googleClientId = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID as string | undefined
const appleServicesId = import.meta.env.PUBLIC_APPLE_SERVICES_ID as string | undefined

const auth = useWebAuth({
  authBase: AUTH,
  googleClientId,
  appleServicesId,
  appleRedirectUri: import.meta.env.PUBLIC_APPLE_REDIRECT_URI as string | undefined,
  locale: contentLangFor(props.lang),
})

const googleSlot = ref<HTMLElement>()
const appleEnabled = computed(() => !!appleServicesId)
const googleEnabled = computed(() => !!googleClientId)

const busy = ref<'' | 'monthly' | 'yearly'>('')
const error = ref('')

const expiresLabel = computed(() => {
  const at = auth.session.value?.tierExpiresAt
  if (!at) return ''
  return new Date(at).toLocaleDateString(contentLangFor(props.lang))
})

function mountGoogle() {
  if (googleSlot.value) auth.mountGoogleButton(googleSlot.value, 300)
}

// The sign-in card is shown inline (no popover toggle), so render the Google
// button as soon as that state is active and its slot is in the DOM.
watch(
  () => auth.ready.value && !auth.signedIn.value && !auth.isPro.value && googleEnabled.value,
  (show) => {
    if (show) nextTick(mountGoogle)
  },
  { immediate: true },
)

async function onApple() {
  await auth.signInApple()
}

// Email OTP sign-in — shared two-step form. On success auth.signedIn flips
// and the card advances to the pricing step, so no onSuccess callback needed.
const {
  step: emailStep,
  email: emailValue,
  code: codeValue,
  busy: emailBusy,
  error: emailError,
  sendCode: onSendCode,
  verify: onVerifyCode,
  changeEmail: onChangeEmail,
} = useEmailOtpForm(auth, t)

async function checkout(plan: 'monthly' | 'yearly') {
  if (busy.value) return
  error.value = ''
  busy.value = plan
  try {
    const token = await auth.ensureToken()
    const res = await fetch(`${BILLING}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan, returnPath: `/${props.lang}/subscribe/success` }),
    })
    if (res.status === 401) {
      auth.resetToken()
      error.value = t('sub.errAuth')
      return
    }
    if (res.status === 403) {
      error.value = t('sub.signInFirst')
      return
    }
    if (res.status === 429) {
      error.value = t('sub.errRate')
      return
    }
    if (!res.ok) {
      error.value = t('sub.errGeneric')
      return
    }
    const { redirectUrl } = (await res.json()) as { redirectUrl?: string }
    if (redirectUrl) {
      window.location.href = redirectUrl
      return
    }
    error.value = t('sub.errGeneric')
  } catch {
    error.value = t('sub.errGeneric')
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  auth.hydrate()
})
</script>

<template>
  <section class="mx-auto max-w-3xl px-5 py-12">
    <header class="text-center">
      <h1 class="font-serif text-3xl font-bold text-ink">{{ t('sub.title') }}</h1>
      <p class="mx-auto mt-3 max-w-xl text-medium">{{ t('sub.lead') }}</p>
    </header>

    <template v-if="auth.ready.value">
      <div v-if="auth.isPro.value" class="mt-10 rounded-2xl border border-saffron/40 bg-saffron/10 p-8 text-center">
        <p class="font-serif text-xl font-semibold text-ink">{{ t('sub.alreadyPro') }}</p>
        <p v-if="expiresLabel" class="mt-2 text-sm text-medium">
          {{ t('sub.expires').replace('{date}', expiresLabel) }}
        </p>
        <a :href="`/${props.lang}/app`" class="mt-6 inline-flex h-10 items-center rounded-lg bg-saffron px-5 text-sm font-semibold text-cream transition hover:bg-saffron-shade">
          {{ t('sub.backToApp') }}
        </a>
      </div>

      <div v-else-if="!auth.signedIn.value" class="mt-10 rounded-2xl border border-line bg-cream-deep/40 p-8 text-center">
        <p class="font-serif text-lg font-semibold text-ink">{{ t('sub.signInFirst') }}</p>
        <div v-if="googleEnabled" ref="googleSlot" class="mt-5 flex justify-center overflow-hidden"></div>
        <button
          v-if="appleEnabled"
          type="button"
          class="mx-auto mt-3 flex h-10 w-[300px] max-w-full items-center justify-center gap-2 rounded-full bg-ink px-4 text-sm font-medium text-cream transition hover:bg-coffee"
          @click="onApple"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M16.36 12.78c.02 2.3 2.02 3.06 2.04 3.07-.02.05-.32 1.1-1.06 2.18-.64.94-1.3 1.87-2.35 1.89-1.02.02-1.35-.6-2.52-.6-1.17 0-1.54.58-2.51.62-1 .04-1.77-1.01-2.42-1.95-1.32-1.92-2.33-5.42-.97-7.78.67-1.18 1.88-1.92 3.19-1.94.99-.02 1.92.66 2.52.66.6 0 1.74-.82 2.93-.7.5.02 1.9.2 2.8 1.52-.07.05-1.67.98-1.65 2.93M14.6 6.16c.53-.64.89-1.53.79-2.42-.76.03-1.69.51-2.24 1.15-.49.56-.92 1.47-.8 2.33.85.07 1.71-.43 2.25-1.06" />
          </svg>
          {{ t('auth.apple') }}
        </button>
        <!-- Passwordless email sign-in -->
        <div class="mx-auto mt-4 w-[300px] max-w-full">
          <div
            v-if="googleEnabled || appleEnabled"
            class="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-medium"
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
              class="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg bg-ink px-4 text-sm font-medium text-cream transition hover:bg-coffee disabled:opacity-60"
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
              class="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg bg-saffron px-4 text-sm font-semibold text-cream transition hover:bg-saffron-shade disabled:opacity-60"
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
      </div>

      <template v-else>
        <div class="mt-10 grid gap-5 sm:grid-cols-2">
          <div class="flex flex-col rounded-2xl border border-line bg-cream p-8">
            <p class="font-serif text-2xl font-semibold text-ink">{{ t('sub.monthly') }}</p>
            <p class="mt-3 font-serif text-5xl font-bold text-ink">2.99 <span class="text-2xl font-semibold">USDT</span></p>
            <p class="mt-1 text-base text-medium">{{ t('sub.perMonth') }}</p>
            <button
              type="button"
              :disabled="!!busy"
              class="mt-6 inline-flex h-11 items-center justify-center rounded-lg border border-saffron px-5 text-sm font-semibold text-saffron transition hover:bg-saffron hover:text-cream disabled:opacity-60"
              @click="checkout('monthly')"
            >
              {{ busy === 'monthly' ? '…' : t('sub.cta') }}
            </button>
          </div>

          <div class="relative flex flex-col rounded-2xl border-2 border-saffron bg-cream p-8">
            <span class="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-saffron px-3 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-cream">
              {{ t('sub.bestValue') }}
            </span>
            <p class="font-serif text-2xl font-semibold text-ink">{{ t('sub.yearly') }}</p>
            <p class="mt-3 font-serif text-5xl font-bold text-ink">29.99 <span class="text-2xl font-semibold">USDT</span></p>
            <p class="mt-1 text-base text-medium">{{ t('sub.perYear') }}</p>
            <button
              type="button"
              :disabled="!!busy"
              class="mt-6 inline-flex h-11 items-center justify-center rounded-lg bg-saffron px-5 text-sm font-semibold text-cream transition hover:bg-saffron-shade disabled:opacity-60"
              @click="checkout('yearly')"
            >
              {{ busy === 'yearly' ? '…' : t('sub.cta') }}
            </button>
          </div>
        </div>

        <p v-if="error" class="mt-5 text-center text-sm font-medium text-crimson">{{ error }}</p>

        <div class="mt-8 space-y-1 text-center text-sm text-medium">
          <p>{{ t('sub.noteExtend') }}</p>
          <p>
            {{ t('sub.noteSupport') }}
            <a :href="`mailto:${STORE.email}`" class="text-saffron underline">{{ STORE.email }}</a>
          </p>
        </div>
      </template>
    </template>
  </section>
</template>
