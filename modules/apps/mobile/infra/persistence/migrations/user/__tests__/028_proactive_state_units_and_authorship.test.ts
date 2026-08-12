import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import { createInMemoryTestDatabase } from "../../../../repositories/sql/__tests__/testDb.js"
import { migration_007_chat_messages } from "../007_chat_messages.js"
import { migration_008_chat_messages_proactive_state } from "../008_chat_messages_proactive_state.js"
import { migration_015_proactive_state_scheduler_authored } from "../015_proactive_state_scheduler_authored.js"
import { migration_028_proactive_state_units_and_authorship } from "../028_proactive_state_units_and_authorship.js"

interface SidecarRow {
  chat_message_id: string
  prepared_at: number | null
  scheduler_authored: number
}

async function seedMessage(
  db: IDatabase,
  id: string,
  sessionId: string,
  role: "user" | "assistant"
): Promise<void> {
  await db.execute(
    "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, 'x', 1600000000000)",
    [id, sessionId, role]
  )
}

async function seedSidecar(
  db: IDatabase,
  id: string,
  ruleKind: string,
  ruleDate: string,
  preparedAt: number | null
): Promise<void> {
  await db.execute(
    `INSERT INTO chat_messages_proactive_state
       (chat_message_id, rule_kind, rule_date, prep_state, prepared_at, visible_at, notify, seen_at)
     VALUES (?, ?, ?, 'ready', ?, NULL, 0, NULL)`,
    [id, ruleKind, ruleDate, preparedAt]
  )
}

async function sidecars(db: IDatabase): Promise<SidecarRow[]> {
  return db.query<SidecarRow>(
    `SELECT chat_message_id, prepared_at, scheduler_authored
       FROM chat_messages_proactive_state ORDER BY chat_message_id`
  )
}

describe("migration 028 — prepared_at units + reclaimed authorship", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await migration_007_chat_messages.up(db)
    await migration_008_chat_messages_proactive_state.up(db)
    await migration_015_proactive_state_scheduler_authored.up(db)
  })

  it("scales a seconds-magnitude prepared_at up to milliseconds, leaving ms stamps alone", async () => {
    await seedMessage(db, "m-sec", "s1", "assistant")
    await seedMessage(db, "m-sec-q", "s1", "user")
    await seedSidecar(db, "m-sec", "enable_notifications_hint", "2023-11-14", 1_700_000_000)
    await seedMessage(db, "m-ms", "s2", "assistant")
    await seedSidecar(db, "m-ms", "holiday", "2023-11-14", 1_700_000_000_000)
    await seedMessage(db, "m-null", "s3", "assistant")
    await seedSidecar(db, "m-null", "weekly_digest", "2023-11-14", null)

    await migration_028_proactive_state_units_and_authorship.up(db)

    const byId = Object.fromEntries((await sidecars(db)).map((r) => [r.chat_message_id, r]))
    expect(byId["m-sec"].prepared_at).toBe(1_700_000_000_000)
    expect(byId["m-ms"].prepared_at).toBe(1_700_000_000_000)
    expect(byId["m-null"].prepared_at).toBeNull()
  })

  // 015 added the column with DEFAULT 0, which relabelled every pre-015
  // autonomous row as an inline-hint cooldown marker unless it carried
  // `notify = 1` or a `visible_at`. Readers act on that flag, so the
  // misclassified rows have to be reclaimed before they are trusted (#1770).
  it("reclaims legacy autonomous rows and leaves genuine cooldown markers at 0", async () => {
    // Rule kind `attach()` can never produce.
    await seedMessage(db, "m-digest", "s-digest", "assistant")
    await seedSidecar(db, "m-digest", "weekly_digest", "2023-11-14", null)

    // An inline-hint kind, but in its own session with no user turn — that is
    // the autonomous tutorial, not a marker on an answer.
    await seedMessage(db, "m-tutorial", "s-tutorial", "assistant")
    await seedSidecar(db, "m-tutorial", "enable_notifications_hint", "2023-11-15", null)

    // A genuine marker: an answer in a conversation the user started.
    await seedMessage(db, "m-answer-q", "s-answer", "user")
    await seedMessage(db, "m-answer", "s-answer", "assistant")
    await seedSidecar(db, "m-answer", "smart_library_hint", "2023-11-16", 1_700_000_000)

    await migration_028_proactive_state_units_and_authorship.up(db)

    const byId = Object.fromEntries((await sidecars(db)).map((r) => [r.chat_message_id, r]))
    expect(byId["m-digest"].scheduler_authored).toBe(1)
    expect(byId["m-tutorial"].scheduler_authored).toBe(1)
    expect(byId["m-answer"].scheduler_authored).toBe(0)
  })

  it("is a no-op on replay", async () => {
    await seedMessage(db, "m-answer-q", "s-answer", "user")
    await seedMessage(db, "m-answer", "s-answer", "assistant")
    await seedSidecar(db, "m-answer", "smart_library_hint", "2023-11-16", 1_700_000_000)

    await migration_028_proactive_state_units_and_authorship.up(db)
    const first = await sidecars(db)
    await migration_028_proactive_state_units_and_authorship.up(db)
    expect(await sidecars(db)).toEqual(first)
  })
})
