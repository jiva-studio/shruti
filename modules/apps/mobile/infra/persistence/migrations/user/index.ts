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
import { migration_010_listening_sessions_fix_negative_delta } from "./010_listening_sessions_fix_negative_delta.js"
import { migration_011_media_items_kind } from "./011_media_items_kind.js"
import { migration_012_playlist_items_collection_id } from "./012_playlist_items_collection_id.js"
import { migration_013_sync_outbox } from "./013_sync_outbox.js"
import { migration_014_sync_doc_hlc } from "./014_sync_doc_hlc.js"
import { migration_015_proactive_state_scheduler_authored } from "./015_proactive_state_scheduler_authored.js"
import { migration_016_listening_sessions_dedupe_storm } from "./016_listening_sessions_dedupe_storm.js"

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
  migration_010_listening_sessions_fix_negative_delta,
  migration_011_media_items_kind,
  migration_012_playlist_items_collection_id,
  migration_013_sync_outbox,
  migration_014_sync_doc_hlc,
  migration_015_proactive_state_scheduler_authored,
  migration_016_listening_sessions_dedupe_storm,
]
