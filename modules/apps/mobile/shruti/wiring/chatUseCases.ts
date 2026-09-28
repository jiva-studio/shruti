import type { ChatSessionId } from "@lib/domain/core.js"
import type {
  IChatMessageRepository,
  IChatSessionRepository,
  IProactiveStateRepository,
} from "@lib/domain/ports/index.js"
import { clearChatHistory, deleteChatSession } from "@usecases/chat/deleteChats.js"
import { useShruti } from "@shruti/shruti.js"

/** The conversation ports the chat modules read and write through. */
export interface ChatThreadPorts {
  readonly sessions: IChatSessionRepository
  readonly messages: IChatMessageRepository
  readonly now: () => number
}

export interface ChatUseCases {
  threads(): ChatThreadPorts
  proactiveState(): IProactiveStateRepository
  deleteSession(id: ChatSessionId): Promise<void>
  clearHistory(): Promise<void>
}

/** The chat ports and use cases, bound to the repositories, which are resolved
 *  per call and so throw until the databases are open. */
export function useChatUseCases(): ChatUseCases {
  const app = useShruti()
  return {
    threads: () => {
      const repos = app.repositories()
      return { sessions: repos.chatSessions, messages: repos.chatMessages, now: Date.now }
    },
    proactiveState: () => app.repositories().proactiveState,
    deleteSession: (id) => {
      const repos = app.repositories()
      return deleteChatSession(id, {
        sessions: repos.chatSessions,
        messages: repos.chatMessages,
        unitOfWork: repos.unitOfWork,
      })
    },
    clearHistory: () => {
      const repos = app.repositories()
      return clearChatHistory({
        sessions: repos.chatSessions,
        messages: repos.chatMessages,
        unitOfWork: repos.unitOfWork,
      })
    },
  }
}
