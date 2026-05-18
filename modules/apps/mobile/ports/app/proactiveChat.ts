export interface ProactiveTurnRequest {
  /** Discriminator the backend uses to pick a per-rule system prompt
   *  (`agent/proactive_prompts/<rule>.md`). The union mirrors what the
   *  backend currently supports. */
  readonly ruleKind: "weekly_digest" | "inactivity" | "holiday"
  /** Local `YYYY-MM-DD` for the day the rule fired — used by the
   *  backend for log correlation and date-stable formatting. */
  readonly ruleDate: string
  /** Free-form JSON the rule's builder feeds the prompt. Stays opaque
   *  to the transport. */
  readonly ruleContext: Record<string, unknown>
}

export interface ProactiveTurnResult {
  /** Full rendered markdown body the scheduler writes into
   *  `chat_messages.content`. Empty string means the LLM produced no
   *  text — caller decides whether that's a degraded state. */
  readonly bodyMd: string
  /** Action-card payloads indexed by their marker id, collected as the
   *  LLM emitted `[action:KIND|id=ID]` markers. Stays `unknown` so this
   *  port doesn't import the domain `ChatActionPayload` discriminated
   *  union — the composition root narrows the type at the call site
   *  via `markerValidator`. */
  readonly actions: Record<string, unknown>
}

/**
 * Boundary between the proactive scheduler (which only cares about
 * "give me body + actions for this rule firing") and the underlying
 * SSE transport that streams `/chat` deltas. Keeping this behind a port
 * lets the rules stay framework-free — they consume `ProactiveContext`
 * which carries an `IProactiveChatService`, not a free function.
 *
 * `locale` is the user's UI language as-is (BCP-47 / ISO 639-1, e.g.
 * `"ru"`, `"en"`, `"en-US"`, `"zh-CN"`). The adapter maps it to whatever
 * the backend actually supports — rules don't enumerate languages, so a
 * new server-side locale lands in one place (the adapter) instead of
 * threading through every rule.
 */
export interface IProactiveChatService {
  run(req: ProactiveTurnRequest, locale: string): Promise<ProactiveTurnResult>
}
