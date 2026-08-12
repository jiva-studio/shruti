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
import { migration_017_library_items } from "./017_library_items.js"
import { migration_018_library_items_references } from "./018_library_items_references.js"
import { migration_020_library_items_source_url } from "./020_library_items_source_url.js"
import { migration_021_library_memberships } from "./021_library_memberships.js"
import { migration_022_library_items_variants } from "./022_library_items_variants.js"
import { migration_023_outbox_owner } from "./023_outbox_owner.js"
import { migration_024_outbox_collection_docid_index } from "./024_outbox_collection_docid_index.js"
import { migration_025_listening_sessions_source_key } from "./025_listening_sessions_source_key.js"
import { migration_026_media_items_evict_pending } from "./026_media_items_evict_pending.js"
import { migration_027_playlist_items_unique_track } from "./027_playlist_items_unique_track.js"
import { migration_028_proactive_state_units_and_authorship } from "./028_proactive_state_units_and_authorship.js"

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
  migration_017_library_items,
  migration_018_library_items_references,
  migration_020_library_items_source_url,
  migration_021_library_memberships,
  migration_022_library_items_variants,
  migration_023_outbox_owner,
  migration_024_outbox_collection_docid_index,
  migration_025_listening_sessions_source_key,
  migration_026_media_items_evict_pending,
  migration_027_playlist_items_unique_track,
  migration_028_proactive_state_units_and_authorship,
]
