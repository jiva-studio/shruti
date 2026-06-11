import type { ChatTurn } from "./chatStreamClient.js"

export interface FetchSessionTitleOptions {
  readonly signal?: AbortSignal
}

/**
 * Boundary for the fire-and-forget `/title` endpoint. Returns the
 * trimmed title on success, or `null` on any failure (network, parse,
 * empty result). Callers MUST treat `null` as "keep the current title"
 * and bump a retry counter rather than surface an error to the UI.
 */
export interface IChatTitleService {
  fetchSessionTitle(
    messages: readonly ChatTurn[],
    lang: string,
    opts?: FetchSessionTitleOptions
  ): Promise<string | null>
}
