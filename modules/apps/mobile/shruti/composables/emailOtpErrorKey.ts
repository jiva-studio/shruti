import { EmailOtpError } from "@ports/app/auth.js"

const KEYS: Record<string, string> = {
  "invalid-email": "settings.account.email.errors.invalidEmail",
  "invalid-code": "settings.account.email.errors.invalidCode",
  throttled: "settings.account.email.errors.throttled",
  disabled: "settings.account.email.errors.disabled",
  network: "settings.account.email.errors.network",
  server: "settings.account.email.errors.server",
}

const GENERIC = "settings.account.email.errors.generic"

/** i18n key for a failed OTP request — anything unrecognised is generic. */
export function emailOtpErrorKey(error: unknown): string {
  if (!(error instanceof EmailOtpError)) return GENERIC
  return KEYS[error.kind] ?? GENERIC
}
