/**
 * Boundary for the fire-and-forget `/questions` endpoint. Returns the
 * server-suggested list of 3-4 short discussion questions for a focus
 * fragment, or an empty array on ANY failure (network, parse, empty
 * result, server-side LLM error). Callers MUST treat `[]` as graceful
 * degradation — render no chips, no toast, no retry.
 */
export interface ChatQuestionsFocusInput {
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

export interface FetchSuggestedQuestionsOptions {
  readonly signal?: AbortSignal
}

export interface IChatQuestionsService {
  fetchSuggestedQuestions(
    focus: ChatQuestionsFocusInput,
    lang: string,
    opts?: FetchSuggestedQuestionsOptions
  ): Promise<readonly string[]>
}
