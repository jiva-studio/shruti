import { ref, type Ref } from 'vue'
import type { UiKey } from '../i18n/ui'
import { WebEmailOtpError, type WebAuth } from './useWebAuth'

export interface EmailOtpForm {
  step: Ref<'idle' | 'sent'>
  email: Ref<string>
  code: Ref<string>
  busy: Ref<boolean>
  error: Ref<string>
  sendCode: () => Promise<void>
  verify: () => Promise<void>
  changeEmail: () => void
}

/**
 * Two-step passwordless email sign-in form state, shared by the Subscribe
 * card and the nav popover. `auth` is the shared useWebAuth singleton; `t`
 * the host's localizer; `onSuccess` fires after a verified sign-in (the
 * Subscribe card lets its reactive `signedIn` advance the view, the nav
 * popover closes itself).
 */
export function useEmailOtpForm(
  auth: WebAuth,
  t: (key: UiKey) => string,
  onSuccess?: () => void,
): EmailOtpForm {
  const step = ref<'idle' | 'sent'>('idle')
  const email = ref('')
  const code = ref('')
  const busy = ref(false)
  const error = ref('')

  function message(e: unknown): string {
    if (e instanceof WebEmailOtpError) {
      switch (e.kind) {
        case 'invalid-email':
          return t('auth.email.errInvalidEmail')
        case 'invalid-code':
          return t('auth.email.errInvalidCode')
        case 'throttled':
          return t('auth.email.errThrottled')
        case 'disabled':
          return t('auth.email.errDisabled')
        case 'network':
          return t('auth.email.errNetwork')
        default:
          return t('auth.email.errGeneric')
      }
    }
    return t('auth.email.errGeneric')
  }

  async function sendCode(): Promise<void> {
    const addr = email.value.trim()
    if (busy.value || !addr) return
    busy.value = true
    error.value = ''
    try {
      await auth.requestEmailCode(addr)
      step.value = 'sent'
    } catch (e) {
      error.value = message(e)
    } finally {
      busy.value = false
    }
  }

  async function verify(): Promise<void> {
    const c = code.value.trim()
    if (busy.value || c.length < 6) return
    busy.value = true
    error.value = ''
    try {
      await auth.verifyEmailCode(email.value.trim(), c)
      onSuccess?.()
    } catch (e) {
      error.value = message(e)
    } finally {
      busy.value = false
    }
  }

  function changeEmail(): void {
    step.value = 'idle'
    code.value = ''
    error.value = ''
  }

  return { step, email, code, busy, error, sendCode, verify, changeEmail }
}
