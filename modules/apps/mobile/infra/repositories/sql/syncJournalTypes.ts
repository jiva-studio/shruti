import type { IDatabase } from "@ports/app/index.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"

export interface SyncJournalDeps {
  /** The user database — same connection the wrapped repositories write to. */
  readonly userDb: IDatabase
  /** Reentrant unit-of-work SHARED with the repository bundle's `unitOfWork`,
   *  so a journal joins the caller's transaction — when the caller hands its
   *  handle down — instead of dead-locking on a nested BEGIN. */
  readonly unitOfWork: IUnitOfWork
  /** Resolves this device's stable id (the HLC tiebreak). Supplied by the
   *  composition root from the auth/device layer; kept as a provider because
   *  the underlying `Device.getId()` is async. */
  readonly getDeviceId: () => Promise<string>
  /** Resolves the account journaling right now — stamped on each row (023
   *  migration) so push can tell a deleted account's un-pushed changes from
   *  the ones the identity replacing it wrote. Read per write, never captured:
   *  the identity changes under a live bundle. Omitted ⇒ rows are unowned. */
  readonly getOwnerId?: () => string | null
  /** Device-local "Sync chats" gate (default ON). Read on every chat write;
   *  when it returns `false` no chat change is journaled. Omitted ⇒ treated as
   *  ON. Never gates the non-chat collections. */
  readonly isChatSyncEnabled?: () => boolean
}

/** The repositories the decorator wraps. */
export interface JournaledUserRepositories {
  readonly notes: INoteRepository
  readonly playlistItems: IPlaylistItemRepository
  readonly listeningSessions: IListeningSessionRepository
  readonly chatSessions: IChatSessionRepository
  readonly chatMessages: IChatMessageRepository
  readonly libraryMemberships: ILibraryMembershipRepository
}
