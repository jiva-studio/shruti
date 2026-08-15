import { describe, expect, it, vi, beforeEach } from "vitest"

const createNote = vi.fn()
const deleteNote = vi.fn()
vi.mock("@usecases/notes/createNote.js", () => ({ createNote: (...a: unknown[]) => createNote(...a) }))
vi.mock("@usecases/notes/deleteNote.js", () => ({ deleteNote: (...a: unknown[]) => deleteNote(...a) }))

import type { TrackId, NoteId } from "@lib/domain/core.js"
import type { INoteRepository } from "@lib/domain/ports/noteRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { useTranscriptSelectionActions } from "../useTranscriptSelectionActions.js"

/**
 * Issue #1845: the popover reported its failures as `Could not save note:
 * text-too-long` / `Could not delete note: not-found` / `Could not load note:
 * <raw JS message>` — English prose around an internal code, shown to every
 * locale. `onError` now carries a key.
 */

const TRACK_ID = "track-1" as TrackId
const NOTE_ID = "note-1" as NoteId

function actions(overrides: { getById?: () => Promise<unknown> } = {}) {
  const onError = vi.fn()
  const notes = {
    getById: overrides.getById ?? (() => Promise.resolve(null)),
  } as unknown as INoteRepository
  const { perform } = useTranscriptSelectionActions({
    getTrackId: () => TRACK_ID,
    getNotes: () => notes,
    getUnitOfWork: () => ({}) as IUnitOfWork,
    shareService: { copyToClipboard: vi.fn(), share: vi.fn() },
    onError,
  })
  return { perform, onError }
}

beforeEach(() => {
  createNote.mockReset()
  deleteNote.mockReset()
})

describe("useTranscriptSelectionActions — failure reporting", () => {
  it.each([
    ["empty-text", "notes.saveError.emptyText"],
    ["text-too-long", "notes.saveError.textTooLong"],
    ["invalid-timestamps", "notes.saveError.invalidRange"],
    ["write-failed", "notes.saveError.writeFailed"],
  ])("reports a rejected bookmark (%s) as a key", async (error, key) => {
    createNote.mockResolvedValue({ ok: false, error })
    const { perform, onError } = actions()

    await perform({ action: "bookmark", text: "hare", timeStart: 0, timeEnd: 10 })

    expect(onError).toHaveBeenCalledWith(key)
  })

  it("reports a note that is already gone as a key", async () => {
    deleteNote.mockResolvedValue({ ok: false, error: "not-found" })
    const { perform, onError } = actions()

    await perform({
      action: "delete",
      text: "",
      timeStart: 0,
      timeEnd: 0,
      noteIds: [NOTE_ID],
    })

    expect(onError).toHaveBeenCalledWith("notes.deleteError.notFound")
  })

  it("keeps a raw JS error message away from the user", async () => {
    const { perform, onError } = actions({
      getById: () => Promise.reject(new Error("SQLITE_BUSY: database is locked")),
    })

    await perform({ action: "ask", text: "", timeStart: 0, timeEnd: 0, noteIds: [NOTE_ID] })

    expect(onError).toHaveBeenCalledWith("notes.openError")
  })
})
