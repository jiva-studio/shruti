<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useT, type Lang } from '../../i18n/ui'
import { contentLangFor } from '../../i18n/locales'
import { useWebAuth } from '../../composables/useWebAuth'

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
  if (googleSlot.value) auth.mountGoogleButton(googleSlot.value)
}

async function onApple() {
  await auth.signInApple()
}

async function checkout(plan: 'monthly' | 'yearly') {
  if (busy.value) return
  error.value = ''
  busy.value = plan
  try {
    const token = await auth.ensureToken()
    const res = await fetch(`${BILLING}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan }),
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
        <div v-if="googleEnabled" ref="googleSlot" class="mt-5 flex justify-center"></div>
        <button
          v-if="appleEnabled"
          type="button"
          class="mx-auto mt-3 flex w-full max-w-xs items-center justify-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-cream transition hover:bg-coffee"
          @click="onApple"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M16.36 12.78c.02 2.3 2.02 3.06 2.04 3.07-.02.05-.32 1.1-1.06 2.18-.64.94-1.3 1.87-2.35 1.89-1.02.02-1.35-.6-2.52-.6-1.17 0-1.54.58-2.51.62-1 .04-1.77-1.01-2.42-1.95-1.32-1.92-2.33-5.42-.97-7.78.67-1.18 1.88-1.92 3.19-1.94.99-.02 1.92.66 2.52.66.6 0 1.74-.82 2.93-.7.5.02 1.9.2 2.8 1.52-.07.05-1.67.98-1.65 2.93M14.6 6.16c.53-.64.89-1.53.79-2.42-.76.03-1.69.51-2.24 1.15-.49.56-.92 1.47-.8 2.33.85.07 1.71-.43 2.25-1.06" />
          </svg>
          {{ t('auth.apple') }}
        </button>
        <button v-else-if="!googleEnabled" type="button" class="mt-5 inline-flex h-10 items-center rounded-lg bg-saffron px-5 text-sm font-semibold text-cream" disabled>
          {{ t('auth.signIn') }}
        </button>
      </div>

      <template v-else>
        <div class="mt-10 grid gap-5 sm:grid-cols-2">
          <div class="flex flex-col rounded-2xl border border-line bg-cream p-6">
            <p class="font-serif text-lg font-semibold text-ink">{{ t('sub.monthly') }}</p>
            <p class="mt-3 font-serif text-3xl font-bold text-ink">$2.99</p>
            <p class="text-sm text-medium">{{ t('sub.perMonth') }}</p>
            <button
              type="button"
              :disabled="!!busy"
              class="mt-6 inline-flex h-11 items-center justify-center rounded-lg border border-saffron px-5 text-sm font-semibold text-saffron transition hover:bg-saffron hover:text-cream disabled:opacity-60"
              @click="checkout('monthly')"
            >
              {{ busy === 'monthly' ? '…' : t('sub.cta') }}
            </button>
          </div>

          <div class="relative flex flex-col rounded-2xl border-2 border-saffron bg-cream p-6">
            <span class="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-saffron px-3 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-cream">
              {{ t('sub.bestValue') }}
            </span>
            <p class="font-serif text-lg font-semibold text-ink">{{ t('sub.yearly') }}</p>
            <p class="mt-3 font-serif text-3xl font-bold text-ink">$29.99</p>
            <p class="text-sm text-medium">{{ t('sub.perYear') }}</p>
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

        <div class="mt-8 space-y-2 rounded-2xl border border-line bg-cream-deep/40 p-5 text-center text-sm text-medium">
          <p>{{ t('sub.usdtNote') }}</p>
          <p>{{ t('sub.oneTimeNote') }}</p>
        </div>
      </template>
    </template>
  </section>
</template>
