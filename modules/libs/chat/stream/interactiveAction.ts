import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ChatActionPayload as WireChatActionPayload } from "@lib/contracts"

/**
 * Wire-to-domain converter for interactive action payloads.
 *
 * The wire nests kind-specific fields under `payload`; the domain keeps the
 * flat shape the persisted rows and the card components already read, so
 * this is the one place that bridges them. `null` on an unknown kind.
 */
export function unwrapInteractiveAction(wire: WireChatActionPayload): ChatActionPayload | null {
  switch (wire.kind) {
    case "share_pdf":
      return { kind: "share_pdf", id: wire.id, items: wire.payload.items }
    case "add_to_library":
      return {
        kind: "add_to_library",
        id: wire.id,
        url: wire.payload.url,
        title: wire.payload.title,
        author: wire.payload.author,
        thumbnail: wire.payload.thumbnail,
      }
    case "enable_daily_reminder":
      return { kind: "enable_daily_reminder", id: wire.id, time: wire.payload.time }
    case "configure_smart_library":
      return {
        kind: "configure_smart_library",
        id: wire.id,
        filters: wire.payload.filters,
      }
    case "upgrade_to_pro":
      return { kind: "upgrade_to_pro", id: wire.id, reason: wire.payload.reason }
    default:
      return null
  }
}
