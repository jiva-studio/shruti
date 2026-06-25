<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useT, type Lang } from '../../i18n/ui'
import { useWebAuth } from '../../composables/useWebAuth'

const props = defineProps<{ lang: Lang }>()
const t = useT(props.lang)

const auth = useWebAuth()
const googleSlot = ref<HTMLElement>()
const open = ref(false)
const busy = ref(false)

const appleEnabled = computed(() => !!(import.meta.env.PUBLIC_APPLE_SERVICES_ID as string | undefined))
const googleEnabled = computed(() => !!(import.meta.env.PUBLIC_GOOGLE_CLIENT_ID as string | undefined))

const displayName = computed(() => {
  const s = auth.session.value
  return s?.name || s?.email || ''
})
const initial = computed(() => (displayName.value.trim()[0] || '?').toUpperCase())

function mountGoogle() {
  if (googleSlot.value) auth.mountGoogleButton(googleSlot.value)
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
  await auth.signOut()
}

onMounted(() => {
  // Surfaces the persisted session (if any) and lands the visitor on the
  // anonymous floor so chat works before any explicit sign-in.
  void auth.ensureToken()
})
</script>

<template>
  <div v-if="auth.ready.value" class="relative flex items-center justify-end gap-2 px-3 py-2 text-sm">
    <template v-if="auth.signedIn.value">
      <span
        class="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-saffron/20 text-xs font-semibold text-saffron"
      >
        <img v-if="auth.session.value?.picture" :src="auth.session.value.picture" alt="" class="h-full w-full object-cover" />
        <span v-else>{{ initial }}</span>
      </span>
      <span class="max-w-[10rem] truncate text-ink-soft">{{ displayName }}</span>
      <span
        v-if="auth.isPro.value"
        class="rounded-full bg-saffron px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-cream"
        >Pro</span
      >
      <button type="button" class="text-medium hover:text-ink" @click="onSignOut">
        {{ t('auth.signOut') }}
      </button>
    </template>

    <template v-else>
      <button
        type="button"
        class="rounded-full border border-line bg-cream px-3 py-1.5 font-medium text-ink-soft transition hover:border-saffron hover:text-saffron"
        @click="toggle"
      >
        {{ t('auth.signIn') }}
      </button>

      <div
        v-if="open"
        class="absolute right-3 top-full z-20 mt-1 w-64 rounded-2xl border border-line bg-cream p-4 shadow-lg"
      >
        <p class="mb-3 text-center text-xs text-medium">{{ t('auth.cta') }}</p>
        <div v-if="googleEnabled" ref="googleSlot" class="flex justify-center"></div>
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
      </div>
    </template>
  </div>
</template>
