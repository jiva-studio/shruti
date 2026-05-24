import type { Migration } from "./types.js"
import { migration_000_migrations_table } from "./000_migrations_table.js"
import { migration_001_config_table } from "./001_config_table.js"
import { migration_002_notes } from "./002_notes.js"
import { migration_003_playlist_items } from "./003_playlist_items.js"
import { migration_004_media_items } from "./004_media_items.js"
import { migration_005_listening_sessions } from "./005_listening_sessions.js"
import { migration_006_notes_meta } from "./006_notes_meta.js"
import { migration_007_chat_messages } from "./007_chat_messages.js"
import { migration_008_chat_messages_proactive_state } from "./008_chat_messages_proactive_state.js"
import { migration_009_chat_sessions_track_id } from "./009_chat_sessions_track_id.js"

/**
 * Ordered list of user-DB migrations. Append new migrations at the end —
 * order determines application order at startup.
 */
export const userMigrations: readonly Migration[] = [
  migration_000_migrations_table,
  migration_001_config_table,
  migration_002_notes,
  migration_003_playlist_items,
  migration_004_media_items,
  migration_005_listening_sessions,
  migration_006_notes_meta,
  migration_007_chat_messages,
  migration_008_chat_messages_proactive_state,
  migration_009_chat_sessions_track_id,
]
