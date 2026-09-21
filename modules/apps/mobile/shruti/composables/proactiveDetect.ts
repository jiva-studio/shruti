import type { ChatMessageId } from "@lib/domain/core.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/proactiveStateRepository.js"
import { resolveSessionId } from "@shruti/proactive/sessions.js"
import { emit } from "@shruti/proactive/events.js"
import type { ProactiveContext, ResolvedProactiveRule } from "@shruti/proactive/types.js"

type SessionRepository = Parameters<typeof resolveSessionId>[3]
type Detection = Awaited<ReturnType<ResolvedProactiveRule["handler"]["detect"]>>[number]

function randomChatMessageId(): ChatMessageId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID() as ChatMessageId
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}` as ChatMessageId
}

/**
 * Mint the chat session and the proactive row for one detection.
 *
 * The session is created first and rolled back when `create` dedups on
 * UNIQUE(rule_kind, rule_date) — a row the earlier lookup missed would
 * otherwise leave an empty session in the history list.
 */
async function createRow(
  detection: Detection,
  rule: ResolvedProactiveRule,
  ctx: ProactiveContext,
  repo: IProactiveStateRepository,
  sessions: SessionRepository
): Promise<void> {
  const sessionId = await resolveSessionId(rule, detection, ctx.nowMs, sessions)
  const created = await repo.create({
    chatMessageId: randomChatMessageId(),
    sessionId,
    role: "assistant",
    content: "",
    createdAt: ctx.nowMs,
    visibleAt: detection.visibleAt,
    notify: detection.notify,
    ruleKind: rule.config.id,
    ruleDate: detection.ruleDate,
    prepState: "pending",
  })
  if (created === null) {
    await sessions.delete(sessionId).catch(() => undefined)
    return
  }
  // The chat store (via useChatStoreProactiveSync) refreshes its session list
  // on this, so the new entry appears without a tab switch.
  emit("row-created")
}

/**
 * Run one rule's detector and persist every instance it reports that this
 * device doesn't already carry. A throwing detector skips the rule for this
 * tick rather than aborting the whole pass.
 */
export async function detectForRule(
  rule: ResolvedProactiveRule,
  ctx: ProactiveContext,
  repo: IProactiveStateRepository,
  sessions: SessionRepository
): Promise<void> {
  let detected: readonly Detection[]
  try {
    detected = [...(await rule.handler.detect(ctx, rule.config))]
  } catch (err) {
    console.warn("[proactive] detect threw", rule.config.id, err)
    return
  }
  for (const detection of detected) {
    // Idempotency before a fresh chat_session is minted — otherwise
    // re-detection on a 30-minute tick litters the history with empty ones.
    const existing = await repo.findByRuleAndDate(rule.config.id, detection.ruleDate)
    if (existing !== null) continue
    try {
      await createRow(detection, rule, ctx, repo, sessions)
    } catch (err) {
      console.warn("[proactive] create threw", rule.config.id, err)
    }
  }
}
