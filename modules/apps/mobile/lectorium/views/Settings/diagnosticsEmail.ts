/** Recent log tail appended to the support email, so the mailto URL stays a
 *  sane length; the full dump goes through the debug "copy logs" action. */
export const SUPPORT_LOG_CHARS = 4000

export interface DiagnosticsFacts {
  readonly userId: string | null
  readonly email: string | null
  readonly tier: string
  readonly isPro: boolean
  readonly appUserId: string | null
  readonly deviceId: string
  readonly platform: string
  readonly appVersion: string
  readonly locale: string
}

export function tailLogs(text: string, maxChars = SUPPORT_LOG_CHARS): string {
  return text.length > maxChars ? text.slice(-maxChars) : text
}

export function buildDiagnosticsBody(intro: string, facts: DiagnosticsFacts, logs: string): string {
  return [
    intro,
    "",
    "—",
    `User ID: ${facts.userId ?? "—"}`,
    `Email: ${facts.email ?? "—"}`,
    `Tier: ${facts.tier}${facts.isPro ? " (pro)" : ""}`,
    `RevenueCat App User ID: ${facts.appUserId ?? "—"}`,
    `Device ID: ${facts.deviceId}`,
    `Platform: ${facts.platform}`,
    `App version: ${facts.appVersion}`,
    `Locale: ${facts.locale}`,
    "",
    "— logs —",
    tailLogs(logs),
  ].join("\n")
}

export function mailtoUrl(to: string, subject: string, body: string): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
