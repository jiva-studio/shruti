import { onUnmounted, ref, type Ref } from "vue"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { emailOtpErrorKey } from "@shruti/composables/emailOtpErrorKey.js"

const RESEND_COOLDOWN_S = 60

export interface EmailSignInForm {
  readonly step: Ref<"email" | "code">
  readonly email: Ref<string>
  readonly code: Ref<string>
  readonly busy: Ref<boolean>
  /** i18n key of the last failure, or "" while there is none. */
  readonly errorKey: Ref<string>
  readonly resendIn: Ref<number>
  reset: () => void
  stop: () => void
  sendCode: () => Promise<void>
  resend: () => Promise<void>
  verify: () => Promise<void>
  backToEmail: () => void
}

/**
 * The email one-time-code sign-in exchange: request a code, resend it behind a
 * cooldown, verify it.
 *
 * The modal is mounted once at the app root and never unmounts, so every
 * request captures a form generation and drops its result when the form was
 * reset in the meantime — a late answer must not stomp a fresh form.
 */
export function useEmailSignInForm(onSignedIn: () => void): EmailSignInForm {
  const auth = useAuthStore()

  const step = ref<"email" | "code">("email")
  const email = ref("")
  const code = ref("")
  const busy = ref(false)
  const errorKey = ref("")
  const resendIn = ref(0)
  let resendTimer: ReturnType<typeof setInterval> | undefined
  let formGen = 0

  function clearResendTimer(): void {
    if (resendTimer) {
      clearInterval(resendTimer)
      resendTimer = undefined
    }
  }

  function startResendCooldown(seconds = RESEND_COOLDOWN_S): void {
    resendIn.value = seconds
    clearResendTimer()
    resendTimer = setInterval(() => {
      resendIn.value -= 1
      if (resendIn.value <= 0) clearResendTimer()
    }, 1000)
  }

  function reset(): void {
    formGen++
    step.value = "email"
    email.value = ""
    code.value = ""
    errorKey.value = ""
    busy.value = false
    resendIn.value = 0
    clearResendTimer()
  }

  /** Run one request under the current generation, reporting its failure. */
  async function run(op: () => Promise<void>): Promise<void> {
    const gen = formGen
    busy.value = true
    errorKey.value = ""
    try {
      await op()
    } catch (e) {
      if (gen !== formGen) return
      errorKey.value = emailOtpErrorKey(e)
    } finally {
      if (gen === formGen) busy.value = false
    }
  }

  async function sendCode(): Promise<void> {
    if (busy.value || !email.value.trim()) return
    const gen = formGen
    await run(async () => {
      await auth.requestEmailCode(email.value.trim())
      if (gen !== formGen) return
      step.value = "code"
      startResendCooldown()
    })
  }

  async function resend(): Promise<void> {
    if (busy.value || resendIn.value > 0) return
    const gen = formGen
    await run(async () => {
      await auth.requestEmailCode(email.value.trim())
      if (gen !== formGen) return
      startResendCooldown()
    })
  }

  async function verify(): Promise<void> {
    if (busy.value || code.value.trim().length < 6) return
    const gen = formGen
    await run(async () => {
      const ok = await auth.signInEmail(email.value.trim(), code.value.trim())
      if (gen !== formGen) return
      if (ok) onSignedIn()
    })
  }

  function backToEmail(): void {
    step.value = "email"
    code.value = ""
    errorKey.value = ""
  }

  onUnmounted(clearResendTimer)

  return {
    step,
    email,
    code,
    busy,
    errorKey,
    resendIn,
    reset,
    stop: clearResendTimer,
    sendCode,
    resend,
    verify,
    backToEmail,
  }
}
