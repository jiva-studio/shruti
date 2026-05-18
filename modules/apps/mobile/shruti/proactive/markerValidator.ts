import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { TrackId } from "@lib/domain/core.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"

/**
 * Strip action markers from a content builder's output that reference
 * non-existent track ids. Returns a tuple `[scrubbed, degraded]` —
 * `scrubbed` is the rewritten body + actions map, and `degraded` is
 * true iff something was actually stripped.
 *
 * The scheduler stores the result and bumps `prep_state` to `degraded`
 * when the flag is set so we can tell from telemetry which content
 * builders are inventing track ids.
 */
export async function validateAndScrubActions(
  bodyMd: string,
  actions: Record<string, ChatActionPayload>,
  tracks: ITrackRepository
): Promise<{
  readonly bodyMd: string
  readonly actions: Record<string, ChatActionPayload>
  readonly degraded: boolean
}> {
  // Collect every track id referenced by any track-bearing action.
  const trackIds = new Set<string>()
  for (const action of Object.values(actions)) {
    if (action.kind === "create_playlist") {
      for (const id of action.trackIds) trackIds.add(id)
    } else if (action.kind === "queue_next_track") {
      trackIds.add(action.trackId)
    }
  }

  if (trackIds.size === 0) {
    return { bodyMd, actions, degraded: false }
  }

  const idList = Array.from(trackIds) as TrackId[]
  const found = await tracks.getByIds(idList)
  const missing = new Set<string>()
  for (const id of idList) {
    if (!found.has(id)) missing.add(id)
  }

  if (missing.size === 0) {
    return { bodyMd, actions, degraded: false }
  }

  // Walk each action and either fix it in place (filter trackIds) or
  // drop it. When an action is dropped, also strip the corresponding
  // marker from the body so the bubble doesn't render an orphan
  // placeholder.
  const scrubbedActions: Record<string, ChatActionPayload> = {}
  const droppedActionIds: string[] = []
  for (const [actionId, action] of Object.entries(actions)) {
    if (action.kind === "create_playlist") {
      const surviving = action.trackIds.filter((id) => !missing.has(id))
      if (surviving.length === 0) {
        droppedActionIds.push(actionId)
        continue
      }
      scrubbedActions[actionId] = { ...action, trackIds: surviving }
    } else if (action.kind === "queue_next_track") {
      if (missing.has(action.trackId)) {
        droppedActionIds.push(actionId)
        continue
      }
      scrubbedActions[actionId] = action
    } else {
      scrubbedActions[actionId] = action
    }
  }

  let scrubbedBody = bodyMd
  for (const id of droppedActionIds) {
    // Match the same marker grammar the parser uses — `[action:KIND|id=ID]`.
    // Permissive kind class because we don't know which kind was dropped.
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`\\[action:[a-z][a-z0-9_]*\\|id=${escapedId}\\]\\s*`, "g")
    scrubbedBody = scrubbedBody.replace(re, "")
  }

  return { bodyMd: scrubbedBody, actions: scrubbedActions, degraded: true }
}
