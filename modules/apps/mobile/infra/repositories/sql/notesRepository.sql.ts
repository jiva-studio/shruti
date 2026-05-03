import type { IDatabase } from "@ports/app/index.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type {
  CreateNoteInput,
  INoteRepository,
  UpdateNoteInput,
} from "@lib/domain/ports/noteRepository.js"
import type { NoteRow } from "@lib/persistence/user"
import { createIdGenerator } from "./idGenerator.js"
import { rowToNote } from "./rowMappers.js"

const newNoteId = createIdGenerator("note")

export function createSqlNoteRepository(db: IDatabase): INoteRepository {
  return {
    async getById(id: NoteId): Promise<Note | null> {
      const rows = await db.query<NoteRow>("SELECT * FROM notes WHERE id = ?", [id])
      return rows[0] ? rowToNote(rows[0]) : null
    },

    async listByTrack(trackId: TrackId): Promise<readonly Note[]> {
      const rows = await db.query<NoteRow>(
        "SELECT * FROM notes WHERE track_id = ? ORDER BY time_start ASC",
        [trackId]
      )
      return rows.map(rowToNote)
    },

    async listRecent(limit: number): Promise<readonly Note[]> {
      const rows = await db.query<NoteRow>("SELECT * FROM notes ORDER BY created_at DESC LIMIT ?", [
        limit,
      ])
      return rows.map(rowToNote)
    },

    async create(input: CreateNoteInput): Promise<Note> {
      const id = newNoteId()
      const now = Date.now()
      await db.execute(
        `INSERT INTO notes (id, track_id, text, time_start, time_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.trackId, input.text, input.timeStart, input.timeEnd, now]
      )
      await db.save()
      return {
        id,
        trackId: input.trackId,
        text: input.text,
        timeStart: input.timeStart,
        timeEnd: input.timeEnd,
        createdAt: now,
      }
    },

    async update(input: UpdateNoteInput): Promise<Note> {
      const existing = await this.getById(input.id)
      if (!existing) throw new Error(`Note not found: ${input.id}`)
      const next: Note = {
        ...existing,
        text: input.text ?? existing.text,
        timeStart: input.timeStart ?? existing.timeStart,
        timeEnd: input.timeEnd ?? existing.timeEnd,
      }
      await db.execute("UPDATE notes SET text = ?, time_start = ?, time_end = ? WHERE id = ?", [
        next.text,
        next.timeStart,
        next.timeEnd,
        input.id,
      ])
      await db.save()
      return next
    },

    async delete(id: NoteId): Promise<void> {
      await db.execute("DELETE FROM notes WHERE id = ?", [id])
      await db.save()
    },

    async clearAll(): Promise<void> {
      await db.execute("DELETE FROM notes")
      await db.save()
    },
  }
}
