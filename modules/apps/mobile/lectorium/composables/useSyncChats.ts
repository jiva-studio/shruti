import { type Ref } from "vue"
import { useConfig } from "@lectorium/composables/useConfig.js"

/**
 * Preferences key for the device-local "Sync chats" toggle. Exported so the
 * Settings UI and the future chat-journaling lane bind to the *same* cached
 * ref (see `useConfig`'s app-wide key→ref cache) rather than duplicating the
 * literal.
 */
export const SYNC_CHATS_ENABLED_KEY = "settings.syncChatsEnabled"

/**
 * Whether the user's Ask Sadhu chat conversations are eligible to sync to the
 * `profile` service (`settings.syncChatsEnabled`). Device-local and **default
 * ON** — the setting itself is never synced to the server; it only gates
 * whether chats are.
 *
 * This is the read contract the chat-journaling lane depends on: call
 * `useSyncChatsEnabled().value` before journaling a chat change to the sync
 * outbox. Two-way `Ref<boolean>` backed by `IPreferences` (Capacitor
 * Preferences); the Settings toggle writes it, every consumer sees the write
 * live.
 */
export function useSyncChatsEnabled(): Ref<boolean> {
  return useConfig<boolean>(SYNC_CHATS_ENABLED_KEY, true)
}
