<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useT, type Lang } from '../../i18n/ui'
import { contentLangFor } from '../../i18n/locales'
import { useWebAuth } from '../../composables/useWebAuth'

const props = defineProps<{ lang: Lang }>()
const t = useT(props.lang)

const BACKEND_FALLBACK = 'https://api.shruti.local'
const AUTH = (import.meta.env.PUBLIC_AUTH_API_URL as string | undefined)?.replace(/\/$/, '') || BACKEND_FALLBACK

const auth = useWebAuth({
  authBase: AUTH,
  googleClientId: import.meta.env.PUBLIC_GOOGLE_CLIENT_ID as string | undefined,
  appleServicesId: import.meta.env.PUBLIC_APPLE_SERVICES_ID as string | undefined,
  appleRedirectUri: import.meta.env.PUBLIC_APPLE_REDIRECT_URI as string | undefined,
  locale: contentLangFor(props.lang),
})

const state = ref<'polling' | 'pro' | 'pending'>('polling')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

onMounted(async () => {
  auth.hydrate()
  for (let i = 0; i < 10; i++) {
    auth.resetToken()
    await auth.ensureToken()
    if (auth.session.value?.tier === 'pro') {
      state.value = 'pro'
      return
    }
    await sleep(3000)
  }
  state.value = 'pending'
})
</script>

<template>
  <section class="mx-auto max-w-xl px-5 py-16 text-center">
    <template v-if="state === 'polling'">
      <span class="dots-spinner mx-auto block" />
      <p class="mt-5 text-medium">{{ t('sub.confirming') }}</p>
    </template>

    <template v-else-if="state === 'pro'">
      <h1 class="font-serif text-3xl font-bold text-ink">{{ t('sub.success') }}</h1>
      <p class="mt-3 text-medium">{{ t('sub.successBody') }}</p>
    </template>

    <template v-else>
      <h1 class="font-serif text-2xl font-bold text-ink">{{ t('sub.pending') }}</h1>
      <p class="mt-3 text-medium">{{ t('sub.pendingBody') }}</p>
    </template>

    <a :href="`/${props.lang}/app`" class="mt-8 inline-flex h-10 items-center rounded-lg bg-saffron px-5 text-sm font-semibold text-cream transition hover:bg-saffron-shade">
      {{ t('sub.backToApp') }}
    </a>
  </section>
</template>
