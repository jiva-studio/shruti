import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import { streamChat, type ProactiveTurnOptions } from "@shruti/services/chatClient.js"

interface CollectResult {
  readonly bodyMd: string
  readonly actions: Record<string, ChatActionPayload>
}

/**
 * Drive a proactive `/chat` request to completion and roll the SSE
 * stream up into a single `body_md` + actions map the scheduler can
 * stash on the row. The user never sees the stream — the chat-tab
 * surface is hidden until `visible_on` rolls forward.
 *
 * Errors become a thrown promise; the scheduler's `buildContent`
 * wrapper catches and flips the row to `degraded`.
 */
export async function runProactiveTurn(
  proactive: ProactiveTurnOptions,
  lang: "ru" | "en"
): Promise<CollectResult> {
  // The backend ignores `messages` when `proactive` is set, but the
  // schema still requires `min_length=1`. A trivial placeholder keeps
  // validation happy without leaking into the prompt.
  const placeholderMessages = [{ role: "user" as const, content: "<proactive>" }]
  let bodyMd = ""
  const actions: Record<string, ChatActionPayload> = {}

  for await (const event of streamChat(placeholderMessages, lang, { proactive })) {
    if (event.type === "delta") {
      bodyMd += event.text ?? ""
      continue
    }
    if (event.type === "action") {
      // The LLM may emit actions with kinds the proactive prompts don't
      // expect (e.g. `save_note` from a builder that didn't get the memo).
      // We keep them — markerValidator scrubs anything that points to
      // missing track ids and the bubble simply doesn't render unknown
      // marker kinds.
      const payload = event.payload as ChatActionPayload
      actions[payload.id] = payload
      continue
    }
    if (event.type === "error") {
      throw new Error(`proactive /chat error: ${event.code} — ${event.message}`)
    }
    if (event.type === "done") break
    // tool_start / tool / outline / cite — silently dropped, the
    // scheduler only cares about the markdown body and action map.
  }

  return { bodyMd, actions }
}
