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
 * `@usecases` may import only `@lib/domain`, and `@ports/app` may
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
 * Who may import it: `@lib/domain`, `@usecases`, `@ports/app`,
 * `@infra/*`, and the composition root.
 */
export type {
  IChatStreamClient,
  ChatRole,
  ChatActionPayload,
  ChatAttribute,
  ChatAttributes,
  ChatOutlinePayload,
  ChatStreamEvent,
  ChatTurn,
  ChatVersePayloadWire,
  ChatCiteTranscriptPayloadWire,
  ChatCommentaryPayloadWire,
  ChatChapterPayloadWire,
  ChatMediaPayloadWire,
  ChatSharePdfItemPayload,
  ChatSharePdfRefPayload,
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
export type { IChatResumeService, ResumedTurn, ResumedTurnState } from "./chat/chatResumeService.js"

/* -------------------------------------------------------------------------- */
/*  Profile-sync wire protocol (POST /profile/sync/{pull,push,cursor}).       */
/*  Transport contract mirrored from the `profile` Go service structs, plus   */
/*  the `ISyncClient` transport port — shared kernel, like the chat contracts */
/*  above, because it is both consumed by the sync engine (@usecases) and     */
/*  implemented by an @infra HTTP adapter.                                     */
/* -------------------------------------------------------------------------- */
export type {
  Hlc,
  SyncOp,
  Change,
  PullRequest,
  PullResponse,
  PushItem,
  PushRequest,
  Ref,
  Conflict,
  PushResponse,
  CursorRequest,
  ISyncClient,
} from "./sync/syncClient.js"

/* -------------------------------------------------------------------------- */
/*  Ingest control-plane wire protocol (POST /orchestrator/run,            */
/*  GET /orchestrator/run/{id}). Mirrored from the orchestrator Go handler; */
/*  the `IIngestClient` transport port is consumed by the library store /      */
/*  retry flow and implemented by an @infra HTTP adapter.                      */
/* -------------------------------------------------------------------------- */
export type {
  IngestState,
  IngestSubmitRequest,
  IngestSubmitResponse,
  IngestStatusResponse,
  IIngestClient,
} from "./ingest/ingestClient.js"

/* -------------------------------------------------------------------------- */
/*  Discovery search wire protocol (POST /discovery/search) — the index of     */
/*  lectures published on archives we do not own. Mirrored from the discovery  */
/*  Go handler; the `IDiscoveryClient` port is consumed by the search surface  */
/*  and implemented by an @infra HTTP adapter.                                 */
/* -------------------------------------------------------------------------- */
export type {
  DiscoveryFilter,
  DiscoverySearchRequest,
  DiscoveryHit,
  DiscoveryHitCollection,
  DiscoveryMessage,
  DiscoverySearchResponse,
  IDiscoveryClient,
} from "./discovery/discoveryClient.js"
export { trackName } from "./discovery/trackName.js"
