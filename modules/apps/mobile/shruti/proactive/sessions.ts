import type { ChatSessionId } from "@lib/domain/core.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { DetectResult, ResolvedProactiveRule } from "./types.js"

/** Stable id of the single "system" chat session used by rules with
 *  `session_strategy: "system_session"`. Created lazily on first use. */
const SYSTEM_SESSION_ID = "sadhu-system" as ChatSessionId

function renderTitleTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = context[key]
    return value === undefined || value === null ? "" : String(value)
  })
}

/**
 * Resolve the chat-session id a proactive message should land in,
 * honouring the rule's `session_strategy`. Creates a session when
 * required.
 */
export async function resolveSessionId(
  rule: ResolvedProactiveRule,
  detect: DetectResult,
  nowMs: number,
  sessions: IChatSessionRepository
): Promise<ChatSessionId> {
  const strategy = rule.config.session_strategy

  if (strategy === "system_session") {
    const existing = await sessions.getById(SYSTEM_SESSION_ID)
    if (existing) return existing.id
    const created = await sessions.create({ id: SYSTEM_SESSION_ID, title: null })
    return created.id
  }

  if (strategy === "append_current") {
    const recent = await sessions.list(1)
    if (recent.length > 0) return recent[0].id
    // No sessions yet — fall through to creating a fresh one with a
    // sensible title rather than erroring.
  }

  // new_session, or fallback for append_current with empty history.
  const title =
    detect.sessionTitleOverride ??
    (rule.config.session_title_template
      ? renderTitleTemplate(rule.config.session_title_template, detect.templateContext)
      : null)
  const id = randomChatSessionId()
  const created = await sessions.create({ id, title })
  void nowMs
  return created.id
}

function randomChatSessionId(): ChatSessionId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID() as ChatSessionId
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}` as ChatSessionId
}
