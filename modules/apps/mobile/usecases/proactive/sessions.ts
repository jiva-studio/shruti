import type { ChatSessionId } from "@lib/domain/core.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type {
  CreateProactiveMessageInput,
  IProactiveStateRepository,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { ProactiveRuleConfig } from "@lib/domain/config.js"
import type { DetectResult } from "./types.js"

/** Stable id of the single "system" chat session used by rules with
 *  `session_strategy: "system_session"`. Created lazily on first use. */
const SYSTEM_SESSION_ID = "sadhu-system" as ChatSessionId

function renderTitleTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = context[key]
    return value === undefined || value === null ? "" : String(value)
  })
}

/** The part of a rule's config that decides its session. */
type SessionConfig = Pick<ProactiveRuleConfig, "session_strategy" | "session_title_template">
/** The part of a detection that names its session. */
type SessionDetect = Pick<DetectResult, "sessionTitleOverride" | "templateContext">

/**
 * Resolve the chat-session id a proactive message should land in,
 * honouring the rule's `session_strategy`. Creates a session when
 * required.
 */
export async function resolveSessionId(
  config: SessionConfig,
  detect: SessionDetect,
  newId: () => string,
  sessions: IChatSessionRepository
): Promise<ChatSessionId> {
  const strategy = config.session_strategy

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
    (config.session_title_template
      ? renderTitleTemplate(config.session_title_template, detect.templateContext)
      : null)
  const created = await sessions.create({ id: newId() as ChatSessionId, title })
  return created.id
}

export interface ProactiveRowStores {
  readonly unitOfWork: IUnitOfWork
  readonly proactiveState: IProactiveStateRepository
}

/** Rolls back a session minted for a row whose `(ruleKind, ruleDate)` already
 *  exists; caught below and never escapes, so it carries no message. */
class RowAlreadyExistsError extends Error {}

/**
 * Mint a proactive row and the chat session it lands in as one transaction.
 * `resolveSession` runs inside it, so a failed insert — or a row that loses the
 * UNIQUE(rule_kind, rule_date) dedup — rolls the session back with it and never
 * leaves an empty conversation in the history list. Returns `null` on dedup.
 */
export async function createProactiveRow(
  stores: ProactiveRowStores,
  resolveSession: () => Promise<ChatSessionId>,
  input: Omit<CreateProactiveMessageInput, "sessionId">
): Promise<ProactiveStateEntry | null> {
  try {
    return await stores.unitOfWork.run(async (tx) => {
      const sessionId = await resolveSession()
      const created = await stores.proactiveState.create({ ...input, sessionId }, tx)
      if (created === null) throw new RowAlreadyExistsError()
      return created
    })
  } catch (err) {
    if (err instanceof RowAlreadyExistsError) return null
    throw err
  }
}
