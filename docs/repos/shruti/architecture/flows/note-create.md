# Flow: Create note

While reading a track's transcript the user drag-selects a span of text and taps **Bookmark** in the selection popover. The selected sentence range — already in milliseconds, read from the `data-time-start` / `data-time-end` attributes on the dragged blocks — plus its text flow through `createNote()`, which validates via the domain entity and hands a fresh `note_<nanoid12>` row to the user DB, anchored to the current `trackId`.

There is no separate note-editor dialog or seconds-based range picker: a note IS the selected transcript span. A second entry point — saving a chat citation chip — reuses the same `createNote()` use case through [`saveCitationAsNote`](https://github.com/akdasa-studios/shruti/blob/main/modules/apps/mobile/usecases/chat/saveCitationAsNote.ts).

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Renderer as TranscriptBlockRenderer.vue
    participant Popover as SelectionActions.vue
    participant Ctrl as useTranscriptDialogController.ts
    participant Sel as useTranscriptSelectionActions.ts
    participant UC as createNote()
    participant Dom as validateNoteFields()<br/>(note.ts)
    participant NoteRepo as INoteRepository<br/>(notesRepository.sql.ts)
    participant DB as user.db

    User->>Renderer: drag-select transcript text
    Renderer->>Popover: show with text + ms range
    User->>Popover: tap "Bookmark"
    Popover->>Ctrl: emit('action', 'bookmark')
    Ctrl->>Sel: perform({ action:'bookmark', text, timeStart, timeEnd })
    Sel->>Sel: clamp ms: timeStart=max(0,…), timeEnd=max(timeStart,…)
    Sel->>UC: createNote({ trackId, text, timeStart, timeEnd }, { notes })

    UC->>Dom: validateNoteFields({ text, timeStart, timeEnd })
    alt text trimmed empty
        Dom-->>UC: err("empty-text")
        UC-->>Sel: err("empty-text")
    else text > 4000 chars
        Dom-->>UC: err("text-too-long")
        UC-->>Sel: err("text-too-long")
    else non-finite / negative / end<start
        Dom-->>UC: err("invalid-time" | "invalid-range")
        UC-->>Sel: err("invalid-timestamps")
    else valid
        Dom-->>UC: ok({ text(trimmed), timeStart, timeEnd })
        UC->>NoteRepo: create({ trackId, text, timeStart, timeEnd, id? })
        opt input.id supplied and row exists
            NoteRepo-->>UC: existing Note (idempotent no-op)
        end
        NoteRepo->>NoteRepo: id = input.id ?? newNoteId()
        NoteRepo->>NoteRepo: now = Date.now()
        NoteRepo->>DB: INSERT INTO notes(..., meta)
        NoteRepo->>DB: db.save()
        DB-->>NoteRepo: ok
        NoteRepo-->>UC: Note { id, …, createdAt: now, meta }
        UC-->>Sel: ok(note)
    end

    alt err
        Sel->>Ctrl: onError("Could not save note: …")
    else ok
        Sel->>Ctrl: onNoteCreated() — refresh stores + re-highlight
    end
```

## What lives where

```mermaid
graph LR
    subgraph ui["@ui/features/transcript"]
        R[TranscriptBlockRenderer.vue]
        P[SelectionActions.vue]
    end
    subgraph comp["shruti/composables"]
        C[useTranscriptDialogController.ts]
        S[useTranscriptSelectionActions.ts]
    end
    subgraph app["@usecases"]
        UC[notes/createNote.ts]
        SC[chat/saveCitationAsNote.ts]
    end
    subgraph dom["@lib/domain"]
        N[Note + validateNoteFields]
        IN[INoteRepository port]
    end
    subgraph infra["@infra/repositories/sql"]
        IM[notesRepository.sql.ts]
        IG[idGenerator.ts]
    end
    subgraph store["user.db (SQLite)"]
        DB[(notes table)]
    end

    R -->|drag selection| P
    P -->|emit action| C
    C --> S
    S --> UC
    SC --> UC
    UC --> N
    UC -.uses port.-> IN
    IM -.implements.-> IN
    IM --> IG
    IM --> DB

    classDef ui fill:#a6e3a1,stroke:#6c7086,color:#1e1e2e;
    classDef comp fill:#89dceb,stroke:#6c7086,color:#1e1e2e;
    classDef app fill:#f9e2af,stroke:#6c7086,color:#1e1e2e;
    classDef dom fill:#cba6f7,stroke:#6c7086,color:#1e1e2e;
    classDef infra fill:#fab387,stroke:#6c7086,color:#1e1e2e;
    classDef store fill:#f38ba8,stroke:#6c7086,color:#1e1e2e;
    class R,P ui;
    class C,S comp;
    class UC,SC app;
    class N,IN dom;
    class IM,IG infra;
    class DB store;
```

## Where validation lives

`createNote` (`modules/apps/mobile/usecases/notes/createNote.ts`) does not validate inline — it delegates to `validateNoteFields` on the domain entity (`modules/libs/domain/note.ts`). The validator trims `text`, rejects empty text and text over `MAX_NOTE_LENGTH` (4000), rejects non-finite times, a negative `timeStart`, or `timeEnd < timeStart`. It returns the *fine-grained* `NoteValidationError` tags (`empty-text`, `text-too-long`, `invalid-time`, `invalid-range`); `createNote` folds the two time-shape tags into a single `invalid-timestamps` so existing UI callers keep their three-case error union. The invariants live on the entity because every path that produces a `Note` (create, update, a future import) must honour them.

## Where ID generation lives

The use case never sees an id unless a caller supplies one. The repository accepts `CreateNoteInput` with an optional `id`; when absent it mints one via the shared factory in `idGenerator.ts`:

```ts
export const createIdGenerator = (prefix: string) => (): string => `${prefix}_${nanoid(12)}`
```

`notesRepository.sql.ts` instantiates `const newNoteId = createIdGenerator("note")`, keeping `nanoid` out of the application/domain layers and giving every entity type (`note_*`, `playlist_*`, `media_*`) one consistent `prefix_<12char>` shape. See [ID generation](../../db/ids.md).

## Idempotent create

When a caller passes `input.id`, the repository becomes idempotent: if a row with that id already exists it is returned unchanged and no duplicate is inserted. This is a deliberate hook for a deterministic-id caller (e.g. deriving a stable id from a chat action id so a flaky-network re-tap on "save as note" can't double-save). No production caller exercises it today — both the transcript bookmark path and `saveCitationAsNote` call `createNote` without an `id`, so every call mints a fresh one; only the repository/use-case tests pass an explicit id.

## Time unit: milliseconds

`Note.timeStart` / `Note.timeEnd` are stored in **milliseconds** — the same unit as the transcript blocks' `start` / `end`. The drag-selection reads `data-time-start` / `data-time-end` straight off the rendered blocks, so the value stays in ms end to end; the DB columns `time_start` / `time_end` are plain `INTEGER`. `useTranscriptSelectionActions` clamps the bookmark range with `Math.round` and `Math.max(0, …)` before calling `createNote`.

## The `meta` sidecar

A note row carries an optional `meta` column — JSON-serialised `Record<string, unknown> | null` (migration `006_notes_meta`). `null` (not `undefined`) means "row exists, no meta yet". `CreateNoteInput.meta` defaults to `null`; the SQL repo serialises it with `JSON.stringify`. On update a non-null object **replaces** the column wholesale (no shallow merge) — callers that want to patch one slot read-merge-write themselves.

## Editing and deleting

`updateNote` re-runs `validateNoteFields` on the *merged* existing+patch values inside a unit-of-work wrapper so the read-then-write is atomic. Deletes go through `deleteNote` (also unit-of-work wrapped) and, from the transcript, are triggered by tap-on-highlight (the `delete` branch of `useTranscriptSelectionActions`). See [`updateNote.ts`](https://github.com/akdasa-studios/shruti/blob/main/modules/apps/mobile/usecases/notes/updateNote.ts) and [Use cases reference](../../api/use-cases.md#updatenote).
