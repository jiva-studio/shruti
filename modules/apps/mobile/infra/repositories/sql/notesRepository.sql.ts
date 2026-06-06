import type { IDatabase } from "@ports/app/index.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note, NoteMeta } from "@lib/domain/note.js"
import type {
  CreateNoteInput,
  INoteRepository,
  UpdateNoteInput,
} from "@lib/domain/ports/noteRepository.js"
import type { NoteRow } from "@lib/persistence/user"
import { mutate, queryMany, queryOne } from "@kit/persistence"
import { createIdGenerator } from "./idGenerator.js"
import { rowToNote } from "./rowMappers.js"

const newNoteId = createIdGenerator("note")

function serializeMeta(meta: NoteMeta | null | undefined): string | null {
  if (meta === null || meta === undefined) return null
  return JSON.stringify(meta)
}

export function createSqlNoteRepository(db: IDatabase): INoteRepository {
  return {
    async getById(id: NoteId): Promise<Note | null> {
      return queryOne<NoteRow, Note>(db, "SELECT * FROM notes WHERE id = ?", [id], rowToNote)
    },

    async listByTrack(trackId: TrackId): Promise<readonly Note[]> {
      return queryMany<NoteRow, Note>(
        db,
        "SELECT * FROM notes WHERE track_id = ? ORDER BY time_start ASC",
        [trackId],
        rowToNote
      )
    },

    async listRecent(limit: number): Promise<readonly Note[]> {
      return queryMany<NoteRow, Note>(
        db,
        "SELECT * FROM notes ORDER BY created_at DESC LIMIT ?",
        [limit],
        rowToNote
      )
    },

    async create(input: CreateNoteInput): Promise<Note> {
      // Idempotent path: caller passes a deterministic id (e.g. derived
      // from a chat action id). If a row already exists with this id,
      // return it as-is so a re-tap after a flaky network is a no-op.
      if (input.id) {
        const existing = await this.getById(input.id)
        if (existing) return existing
      }
      const id = input.id ?? newNoteId()
      const now = Date.now()
      const meta = input.meta ?? null
      await mutate(
        db,
        `INSERT INTO notes (id, track_id, text, time_start, time_end, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, input.trackId, input.text, input.timeStart, input.timeEnd, now, serializeMeta(meta)]
      )
      return {
        id,
        trackId: input.trackId,
        text: input.text,
        timeStart: input.timeStart,
        timeEnd: input.timeEnd,
        createdAt: now,
        meta,
      }
    },

    async update(input: UpdateNoteInput): Promise<Note> {
      const existing = await this.getById(input.id)
      if (!existing) throw new Error(`Note not found: ${input.id}`)
      const nextMeta = input.meta === undefined ? existing.meta : input.meta
      const next: Note = {
        ...existing,
        text: input.text ?? existing.text,
        timeStart: input.timeStart ?? existing.timeStart,
        timeEnd: input.timeEnd ?? existing.timeEnd,
        meta: nextMeta,
      }
      await mutate(
        db,
        "UPDATE notes SET text = ?, time_start = ?, time_end = ?, meta = ? WHERE id = ?",
        [next.text, next.timeStart, next.timeEnd, serializeMeta(next.meta), input.id]
      )
      return next
    },

    async delete(id: NoteId): Promise<void> {
      await mutate(db, "DELETE FROM notes WHERE id = ?", [id])
    },

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM notes")
    },
  }
}
