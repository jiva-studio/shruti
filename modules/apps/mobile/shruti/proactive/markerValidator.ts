import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { TrackId } from "@lib/domain/core.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"

function collectTrackIds(actions: Record<string, ChatActionPayload>): Set<string> {
  const ids = new Set<string>()
  for (const action of Object.values(actions)) {
    if (action.kind === "queue_next_track") ids.add(action.trackId)
  }
  return ids
}

function splitActions(
  actions: Record<string, ChatActionPayload>,
  missing: ReadonlySet<string>
): { kept: Record<string, ChatActionPayload>; droppedIds: string[] } {
  const kept: Record<string, ChatActionPayload> = {}
  const droppedIds: string[] = []
  for (const [actionId, action] of Object.entries(actions)) {
    if (action.kind === "queue_next_track" && missing.has(action.trackId)) droppedIds.push(actionId)
    else kept[actionId] = action
  }
  return { kept, droppedIds }
}

// Marker grammar mirrors the parser's — `[action:KIND|id=ID]`. The kind class
// is permissive because the dropped action's kind is not known here.
export function stripActionMarkers(bodyMd: string, actionIds: readonly string[]): string {
  let body = bodyMd
  for (const id of actionIds) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    body = body.replace(new RegExp(`\\[action:[a-z][a-z0-9_]*\\|id=${escapedId}\\]\\s*`, "g"), "")
  }
  return body
}

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
  const trackIds = collectTrackIds(actions)
  if (trackIds.size === 0) return { bodyMd, actions, degraded: false }

  const idList = Array.from(trackIds) as TrackId[]
  const found = await tracks.getByIds(idList)
  const missing = new Set(idList.filter((id) => !found.has(id)))
  if (missing.size === 0) return { bodyMd, actions, degraded: false }

  const { kept, droppedIds } = splitActions(actions, missing)
  return { bodyMd: stripActionMarkers(bodyMd, droppedIds), actions: kept, degraded: true }
}
