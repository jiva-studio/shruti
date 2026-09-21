import type { ChatMessageError } from "@lib/domain/chatMessage.js"
import { attributeValue, CHAT_ATTR_REPLY_LANGUAGE } from "@lib/domain/chatMessage.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { ChatTurn } from "@lib/contracts"
import type { RunChatTurnEvent } from "./chatTurnEvents.js"
import type { RunChatTurnInput, RunChatTurnDeps } from "./runChatTurn.js"
import type { TurnCards } from "./chatActionFold.js"
import type { TurnFoldState } from "./chatStreamFold.js"
import { streamErrorEvent } from "./chatTurnError.js"

/** What the message records about how the turn ended. */
function errorMarkerFor(aborted: boolean, state: TurnFoldState): ChatMessageError | undefined {
  if (aborted && !state.sawDone) return { kind: "stopped" }
  if (state.sawDone || state.acc.length === 0) return undefined
  return {
    kind: "truncated",
    reason: state.sawTurnsLimit ? "turns" : (state.lastError?.code ?? "stream"),
  }
}

/** Persist the assistant reply, or say why there is none. */
export async function* finaliseTurn(
  input: RunChatTurnInput,
  deps: RunChatTurnDeps,
  assistantId: ChatMessageId,
  cards: TurnCards,
  state: TurnFoldState
): AsyncIterable<RunChatTurnEvent> {
  const errorMeta = errorMarkerFor(input.signal.aborted, state)

  if (state.acc.length > 0) {
    const followups = deps.extractFollowups(state.acc)
    const finalised = await deps.messages.create({
      id: assistantId,
      sessionId: input.sessionId,
      role: "assistant",
      content: state.acc,
      createdAt: input.finalisedCreatedAt ?? deps.now(),
      ...cards,
      error: errorMeta,
      followups: followups.length > 0 ? followups : undefined,
      aliases: state.aliases,
      attributes: state.attributes,
    })
    // The session's own recency is "when this landed", which is now — not the
    // pinned row timestamp, which can be older than the turn that superseded
    // this one and would drag the conversation back down the history list.
    await deps.sessions.touch(input.sessionId, deps.now())
    yield { kind: "finalised", message: finalised }
  } else if (input.signal.aborted && !state.sawDone) {
    // User tapped stop before any prose landed (and before `done`).
    // Nothing useful to preserve, and converting the placeholder to a
    // "no content" failed-bubble would suggest something went wrong —
    // it didn't, the user just changed their mind. Emit a dedicated
    // code the store recognises so it can drop the placeholder
    // silently. `!sawDone` mirrors the errorMeta gate above: an abort
    // landing in the post-`done` usage wait is a completed (empty)
    // turn, not a user stop.
    yield { kind: "error", code: "stopped_empty", message: "stopped" }
  } else if (state.lastError) {
    yield {
      kind: "error",
      ...streamErrorEvent(state.lastError),
    }
  } else {
    // No text and no error — empty `done`. Store drops the placeholder.
    yield {
      kind: "error",
      code: "empty",
      message: "no content",
    }
  }
}

/** First turn only. A failed `/title` leaves the locally-derived one. */
export async function* refreshSessionTitle(
  input: RunChatTurnInput,
  deps: RunChatTurnDeps,
  state: TurnFoldState
): AsyncIterable<RunChatTurnEvent> {
  if (input.isFirstAssistantTurn && state.acc.length > 0 && deps.title) {
    const turns: readonly ChatTurn[] = [
      { role: "user", content: input.text },
      { role: "assistant", content: state.acc },
    ]
    // The title names a reply, so it is written in the reply's language — the
    // one the server settled for this turn, which is not always the language
    // the client asked in (an English question in a Russian-set app is
    // answered in English). No settled attribute ⇒ the requested language.
    const settledLang = state.attributes?.[CHAT_ATTR_REPLY_LANGUAGE]
    const titleLang = (settledLang ? attributeValue(settledLang) : "") || input.lang
    try {
      const newTitle = await deps.title.fetchSessionTitle(turns, titleLang, {
        signal: input.signal,
      })
      if (newTitle) {
        await deps.sessions.updateTitle(input.sessionId, newTitle)
        yield { kind: "title-updated", title: newTitle }
      }
    } catch {
      // /title backend is broken or call aborted — accept the null
      // title and move on. Generic header is fine.
    }
  }
}
