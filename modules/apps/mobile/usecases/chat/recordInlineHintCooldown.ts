import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ProactiveRuleId } from "@lib/domain/config.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/proactiveStateRepository.js"

type InlineHintRuleKind = Extract<
  ProactiveRuleId,
  "enable_notifications_hint" | "smart_library_hint"
>

/**
 * Map an inline action card (rendered alongside an assistant message)
 * to its autonomous-rule counterpart so the scheduler can suppress the
 * standalone proactive turn for the rest of the day. Returns null for
 * action kinds that have no autonomous-rule equivalent (e.g.
 * `upgrade_to_pro`).
 */
export function inlineHintToRuleKind(kind: ChatActionPayload["kind"]): InlineHintRuleKind | null {
  if (kind === "enable_daily_reminder") return "enable_notifications_hint"
  if (kind === "configure_smart_library") return "smart_library_hint"
  return null
}

export interface RecordInlineHintCooldownInput {
  readonly chatMessageId: ChatMessageId
  readonly payload: ChatActionPayload
  /** Caller injects the clock so the use case stays deterministic in
   *  tests and pure of `Date.now()`/`new Date()` calls. */
  readonly now: Date
}

export interface RecordInlineHintCooldownDeps {
  readonly proactiveState: IProactiveStateRepository
}

/**
 * Stamp a `proactive_state` row in the `ready` state for an inline hint
 * the user just saw on an assistant message. The scheduler reads the
 * same table and uses `(ruleKind, ruleDate)` as its dedup key, so this
 * effectively suppresses the autonomous version of the same hint for
 * the rest of the day.
 *
 * Throws on repo failure — callers handle the swallow (the cooldown is
 * a best-effort cleanup; missing it just means the tutorial may double
 * up next time the rule fires).
 */
export async function recordInlineHintCooldown(
  input: RecordInlineHintCooldownInput,
  deps: RecordInlineHintCooldownDeps
): Promise<void> {
  const ruleKind = inlineHintToRuleKind(input.payload.kind)
  if (ruleKind === null) return
  const ruleDate = formatLocalISODate(input.now)
  await deps.proactiveState.attach(
    input.chatMessageId,
    ruleKind,
    ruleDate,
    "ready",
    Math.floor(input.now.getTime() / 1000)
  )
}

function formatLocalISODate(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
