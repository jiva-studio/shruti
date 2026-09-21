import type { ChatTurn } from "@lib/contracts"
import {
  newIdempotencyKey,
  resolveAccessToken,
  type AccessTokenProvider,
  type ChatRequest,
} from "./chatHttp.js"

/* -------------------------------------------------------------------------- */
/*                               Title generator                              */
/* -------------------------------------------------------------------------- */

/**
 * POST /title — quick LLM-rephrased chat session title (3-5 words).
 * Called fire-and-forget after the first assistant reply to replace the
 * crude `deriveTitle(text)` truncation. Returns the trimmed title on
 * success, or `null` on any failure (HTTP error, network, parse). The
 * caller MUST treat a null return as "keep the current title".
 */
export async function fetchSessionTitle(
  messages: readonly ChatTurn[],
  lang: string,
  opts: {
    request: ChatRequest
    getAccessToken: AccessTokenProvider
    signal?: AbortSignal
  }
): Promise<string | null> {
  if (messages.length === 0) return null

  let token: string
  try {
    token = await resolveAccessToken(opts.getAccessToken)
  } catch {
    // /title is fire-and-forget; no recovery surface if auth is unrecoverable.
    return null
  }

  try {
    const response = await opts.request("/title", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": newIdempotencyKey(),
      },
      body: JSON.stringify({ messages, lang }),
      signal: opts.signal,
    })
    if (!response.ok) return null
    const body = (await response.json()) as { title?: unknown }
    const title = typeof body.title === "string" ? body.title.trim() : ""
    return title.length > 0 ? title : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*                          Suggested-questions generator                     */
/* -------------------------------------------------------------------------- */

/** Wire shape for the `/questions` request body. Server expects
 *  camelCase for `focus.*` fields (Pydantic alias = trackId / startMs /
 *  endMs / trackTitle / authorName). `lang` is the UI language. */
export interface QuestionsFocusInput {
  readonly trackId: string
  readonly startMs: number
  readonly endMs: number
  readonly text: string
  readonly sourceKey?: string
  readonly trackTitle?: string
  readonly authorName?: string
  readonly date?: string
  readonly location?: string
}

/**
 * POST /questions — 3-4 short suggestion chips for the focus fragment
 * the user just dropped into the chat. Fire-and-forget on the client
 * side: any error path (network, HTTP non-2xx, parse failure, server
 * returned []) collapses to an empty list, which the UI renders as
 * "no chips" without a toast. The caller MUST treat the empty result
 * as graceful degradation, not as a hard failure.
 */
export async function fetchSuggestedQuestions(
  focus: QuestionsFocusInput,
  lang: string,
  opts: {
    request: ChatRequest
    getAccessToken: AccessTokenProvider
    signal?: AbortSignal
  }
): Promise<readonly string[]> {
  let token: string
  try {
    token = await resolveAccessToken(opts.getAccessToken)
  } catch {
    // /questions is fire-and-forget; empty chips on auth failure is the
    // graceful path (caller renders "no chips" without a toast).
    return []
  }

  try {
    const response = await opts.request("/questions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": newIdempotencyKey(),
      },
      body: JSON.stringify({ focus, lang }),
      signal: opts.signal,
    })
    if (!response.ok) return []
    const body = (await response.json()) as { questions?: unknown }
    if (!Array.isArray(body.questions)) return []
    return body.questions
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/*                          POST /chat/feedback client                        */
/* -------------------------------------------------------------------------- */

export type FeedbackValue = "up" | "down"
export type FeedbackCategory =
  | "off_topic"
  | "no_results"
  | "bad_citations"
  | "wrong_language"
  | "factually_wrong"
  | "other"

export interface FeedbackPayload {
  /** Local `ChatMessage.id` of the assistant message (UUIDv4). Sent on
   *  the wire as the hyphenless 32-hex form, which is the same value
   *  that was used as the Langfuse trace_id when the turn streamed. */
  readonly messageId: string
  readonly value: FeedbackValue
  /** Only meaningful when `value === "down"`. Server silently ignores
   *  it on `up` per state-machine contract. */
  readonly category?: FeedbackCategory
  /** Optional free-form text (≤500 chars). Server truncates to 500;
   *  we don't enforce the limit here so a copy-paste of a long
   *  paragraph still uploads (just truncated). */
  readonly comment?: string
}

/**
 * Persist the user's thumbs-up/down (with optional category + comment)
 * to the backend. Throws on non-2xx HTTP or network failure — the
 * caller is responsible for revert + retry.
 */
export async function postFeedback(
  payload: FeedbackPayload,
  opts: {
    request: ChatRequest
    getAccessToken: AccessTokenProvider
    signal?: AbortSignal
  }
): Promise<void> {
  const token = await resolveAccessToken(opts.getAccessToken)

  const traceId = payload.messageId.replace(/-/g, "").toLowerCase()
  const body: Record<string, unknown> = {
    trace_id: traceId,
    value: payload.value,
  }
  if (payload.category) body.category = payload.category
  if (payload.comment) body.comment = payload.comment

  const response = await opts.request("/chat/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`feedback failed: ${response.status} ${text || response.statusText}`)
  }
}
