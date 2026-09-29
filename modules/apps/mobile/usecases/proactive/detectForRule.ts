import type { ChatMessageId } from "@lib/domain/core.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/proactiveStateRepository.js"
import { createProactiveRow, resolveSessionId } from "./sessions.js"
import type { ProactiveContext, ProactiveEvent, ResolvedProactiveRule } from "./types.js"

type SessionRepository = Parameters<typeof resolveSessionId>[3]
type Detection = Awaited<ReturnType<ResolvedProactiveRule["handler"]["detect"]>>[number]

/**
 * Mint the chat session and the proactive row for one detection.
 *
 * Both land in one transaction: a failed insert, or one that dedups on
 * UNIQUE(rule_kind, rule_date) because the earlier lookup missed a row, rolls
 * the session back instead of leaving an empty one in the history list.
 */
async function createRow(
  detection: Detection,
  rule: ResolvedProactiveRule,
  ctx: ProactiveContext,
  repo: IProactiveStateRepository,
  sessions: SessionRepository,
  emit: (event: ProactiveEvent) => void
): Promise<void> {
  const created = await createProactiveRow(
    { unitOfWork: ctx.repos.unitOfWork, proactiveState: repo },
    () => resolveSessionId(rule.config, detection, ctx.newId, sessions),
    {
      chatMessageId: ctx.newId() as ChatMessageId,
      role: "assistant",
      content: "",
      createdAt: ctx.nowMs,
      visibleAt: detection.visibleAt,
      notify: detection.notify,
      ruleKind: rule.config.id,
      ruleDate: detection.ruleDate,
      prepState: "pending",
    }
  )
  if (created === null) return
  // The chat store refreshes its session list on this, so the new entry
  // appears without a tab switch.
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
  sessions: SessionRepository,
  emit: (event: ProactiveEvent) => void
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
      await createRow(detection, rule, ctx, repo, sessions, emit)
    } catch (err) {
      console.warn("[proactive] create threw", rule.config.id, err)
    }
  }
}
