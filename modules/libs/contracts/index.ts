/**
 * `@lib/contracts` — the app's **Published Language** (DDD) / dependency-free
 * **shared-kernel** layer.
 *
 * It holds the wire/transport contracts that are shared across more than one
 * layer — most notably the chat SSE protocol, which is consumed by an
 * application use case (`runChatTurn`) AND implemented by an infrastructure
 * adapter (`@infra/chat/http/*`).
 *
 * The layered dependency rule structurally forbids a shared home for these:
 * `@lib/application` may import only `@lib/domain`, and `@ports/app` may
 * import nothing. A use case that needs the chat-stream port therefore had no
 * place to import it from without breaking a rule. This module is that place.
 *
 * Rules of the layer (enforced by ESLint `no-restricted-imports`):
 * - **Zero dependencies.** Pure types only — no `@lib/domain`, no `@ports`,
 *   no `@infra`, no framework. It sits at the foundation, beside the domain.
 * - It is a *transport* contract, not the domain model. The domain keeps its
 *   own clean (camelCase) `ChatActionPayload` / `ChatOutlinePayload`; this
 *   layer carries the snake_case wire shapes the server actually emits.
 *
 * Who may import it: `@lib/domain`, `@lib/application`, `@ports/app`,
 * `@infra/*`, and the composition root.
 */
export type {
  IChatStreamClient,
  ChatRole,
  ChatActionPayload,
  ChatOutlinePayload,
  ChatStreamEvent,
  ChatTurn,
  ChatVersePayloadWire,
  ChatCiteTranscriptPayloadWire,
  ChatSharePdfItemPayload,
  ResearchSourceKind,
  StreamChatOptions,
} from "./chat/chatStreamClient.js"
export type { IChatTitleService, FetchSessionTitleOptions } from "./chat/chatTitleService.js"
export type {
  IChatQuestionsService,
  ChatQuestionsFocusInput,
  FetchSuggestedQuestionsOptions,
} from "./chat/chatQuestionsService.js"
export type {
  IProactiveChatService,
  ProactiveTurnRequest,
  ProactiveTurnResult,
} from "./chat/proactiveChat.js"
export type {
  IChatFeedbackService,
  FeedbackPayload,
  FeedbackValue,
  FeedbackCategory,
  SubmitChatFeedbackOptions,
} from "./chat/chatFeedbackService.js"
