import type {
  ChatActionPayload,
  ChatActionState,
  ChatMessage as DomainChatMessage,
  ChatOutlinePayload,
  ChatSession as DomainChatSession,
} from "@lib/domain"

export type ChatSession = DomainChatSession
export type ActionPayload = ChatActionPayload
export type OutlinePayload = ChatOutlinePayload
export type ActionState = ChatActionState

export type ChatResearchSource = {
  readonly sourceKind: "verse" | "lecture_chunk" | "library_doc"
  readonly label: string
}

/** Interpolation values for a status i18n key, e.g. `{ intent: "research" }`. */
export type ChatStatusParams = Readonly<Record<string, string | number>>

/**
 * A stored chat message plus the fields that live only while its turn streams.
 *
 * `statusKey`, `researchQuestions` and `researchSources` are ephemeral: they
 * ride on the streaming bubble and are dropped on `finalised`. The research
 * sources are keyed by the server's stable id so the same source, emitted by
 * several sub-queries, collapses into one chip.
 */
export type ChatMessage = DomainChatMessage & {
  streaming?: boolean
  statusKey?: string
  statusParams?: ChatStatusParams
  researchQuestions?: readonly string[]
  researchSources?: ReadonlyMap<string, ChatResearchSource>
}
