import type { ChatMessage } from "@lib/domain/chatMessage.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { ChatFoldEvent } from "@lib/chat/stream/chatFoldEvents.js"

/** Snapshot of what the store needs to mutate on every step of the
 *  turn. The use-case yields these as plain events; the store
 *  translates each into reactive mutations. */
export type RunChatTurnEvent =
  | ChatFoldEvent
  | { readonly kind: "user-message"; readonly message: ChatMessage }
  | {
      readonly kind: "assistant-placeholder"
      readonly messageId: ChatMessageId
    }
  | { readonly kind: "finalised"; readonly message: ChatMessage }
  | {
      readonly kind: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
      /** Quota tier the limit was looked up under ("anonymous" | "free"
       *  | "pro"). Set only on `code: "rate_limited"`; absent for other
       *  error codes and from servers that don't emit this field. The
       *  store keys the inline-notice copy + CTA off this. */
      readonly tier?: string
      /** Server-side reset boundary in UTC Unix-seconds. Same caveats
       *  as `tier`. Store converts to absolute UnixMs before persisting
       *  on the ChatMessageError so countdowns survive backgrounding. */
      readonly resetsAtEpoch?: number
      /** Post-increment counter for the rejecting bucket. The store
       *  uses this with `limit` to hydrate the usage chip from the
       *  429 body. Only set on `code: "rate_limited"`. */
      readonly current?: number
      /** Per-user limit the request was checked against. */
      readonly limit?: number
      /** Which bucket exhausted: `user` (per-JWT) vs `ip` (per-IP). The
       *  usage chip only hydrates on `user`; `ip` means a CGNAT peer
       *  hammered the IP cap and this user's quota is fine. */
      readonly keyType?: "user" | "ip"
    }
  | { readonly kind: "title-updated"; readonly title: string }
