import type {
  IProactiveChatService,
  ProactiveTurnRequest,
  ProactiveTurnResult,
} from "@lib/contracts"

import { streamChat, type AccessTokenProvider, type ChatRequest } from "./chatClient.js"

export interface HttpProactiveChatServiceDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Failover-aware HTTP client for the chat service. */
  readonly request: ChatRequest
}

/**
 * HTTP-SSE adapter for `IProactiveChatService`. Wraps the existing
 * `streamChat` SSE client — the backend swaps system-prompt + ignores
 * `messages` when `proactive` is set, so the placeholder turn here is
 * just there to keep the request-body validator (`min_length=1`) happy.
 *
 * Stream is collapsed into a single body+actions snapshot — proactive
 * messages don't stream to the user, the scheduler only stores the
 * final result on `chat_messages.content`.
 */
export function createHttpProactiveChatService(
  deps: HttpProactiveChatServiceDeps
): IProactiveChatService {
  return {
    async run(req: ProactiveTurnRequest, locale: string): Promise<ProactiveTurnResult> {
      const placeholderMessages = [{ role: "user" as const, content: "<proactive>" }]
      let bodyMd = ""
      const actions: Record<string, unknown> = {}
      // Map BCP-47 / arbitrary locale strings down to the two languages
      // the backend currently has prompts for. Everything that doesn't
      // start with `en` falls back to `ru` — matches the rest of the
      // app's English-or-Russian default. When the backend ships a new
      // prompt locale (e.g. zh, hi), add the case here.
      const wireLocale: "ru" | "en" = locale.toLowerCase().startsWith("en") ? "en" : "ru"

      for await (const event of streamChat(placeholderMessages, wireLocale, {
        getAccessToken: deps.getAccessToken,
        request: deps.request,
        proactive: {
          ruleKind: req.ruleKind,
          ruleDate: req.ruleDate,
          ruleContext: req.ruleContext,
        },
      })) {
        if (event.type === "delta") {
          bodyMd += event.text ?? ""
          continue
        }
        if (event.type === "action") {
          // payload shape varies per action kind — the validator at
          // `proactive/markerValidator.ts` narrows it before any UI
          // consumer touches it. Here we just key by id.
          const payload = event.payload as { id?: string }
          if (payload && typeof payload.id === "string") {
            actions[payload.id] = payload
          }
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
    },
  }
}
